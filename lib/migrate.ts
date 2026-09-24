import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import type { InStatement } from "@libsql/core/api";

/** Agrega una columna si todavía no existe (idempotente, igual que en migrate.mjs). */
async function agregarColumna(
  db: Awaited<ReturnType<typeof getDb>>,
  tabla: string,
  columna: string,
  definicion: string,
): Promise<void> {
  try {
    await db.execute(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
  } catch (error) {
    const mensaje = String(error);
    if (
      !mensaje.includes("duplicate column") &&
      !mensaje.includes("already has column")
    ) {
      throw error;
    }
  }
}

/**
 * Ejecuta el esquema inicial (lib/schema.sql) de forma idempotente.
 *
 * Pensado para correrse a mano con `npm run db:migrate` contra Turso o la
 * base local, pero también se puede invocar desde Route Handlers si se quiere
 * auto-migrar en el primer deploy.
 */
export async function migrate(): Promise<void> {
  const sql = readFileSync(join(process.cwd(), "lib", "schema.sql"), "utf8");

  // PRAGMA foreign_keys no se puede configurar por sesión remota de forma
  // persistente, pero Turso lo habilita por defecto. El pragma dentro del
  // schema sirve para la base local.
  const db = await getDb();
  await db.executeMultiple(sql);

  // Columnas agregadas en versiones posteriores al esquema inicial.
  // `numero` (N° visible de cliente) ya no se carga a mano: SIEMPRE es igual
  // al id. Acá se deja el backfill idempotente por si quedó des-sincronizado
  // (clientes viejos cargados con un N° manual).
  await agregarColumna(db, "clientes", "numero", "INTEGER");

  // Todos los clientes registrados operan en cuenta corriente (clientes fijos).
  // La columna se agrega con default 1: los clientes ya creados quedan así.
  await agregarColumna(
    db,
    "clientes",
    "es_cuenta_corriente",
    "INTEGER NOT NULL DEFAULT 1",
  );
  await db.execute(
    "UPDATE clientes SET numero = id WHERE numero IS NULL OR numero != id",
  );

  // El reparto se vincula a un cliente (campo "Envía"), puede llevar remito
  // o una mercadería directa, y registra la forma de pago. `cobrado` indica si
  // la mercadería ya se cobró: mientras es 0, la forma de pago queda vacía.
  await agregarColumna(db, "repartos", "cliente_id", "INTEGER REFERENCES clientes(id) ON DELETE SET NULL");
  await agregarColumna(db, "repartos", "lleva_remito", "INTEGER NOT NULL DEFAULT 0");
  await agregarColumna(db, "repartos", "forma_pago", "TEXT NOT NULL DEFAULT 'contado' CHECK (forma_pago IN ('contado', 'cuenta_corriente', 'debito', 'cheque'))");
  await agregarColumna(db, "repartos", "cobrado", "INTEGER NOT NULL DEFAULT 0");

  // Índice sobre la nueva columna: se crea acá (y no en schema.sql) porque las
  // bases existentes todavía no tienen la columna cuando se ejecuta el schema.
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_repartos_cliente ON repartos(cliente_id)",
  );

  // Índices compuestos para acelerar la deuda de clientes y el resumen de
  // cobros diarios. Idempotentes y seguros de correr varias veces.
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_repartos_cliente_cobrado ON repartos(cliente_id, cobrado)",
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_remitos_fecha ON remitos(fecha)",
  );

  // La mercadería directa pasó de ser una sola línea en `repartos` a varias
  // líneas en `reparto_items`. Si la tabla vieja todavía tiene las columnas
  // (de migraciones anteriores), se vuelcan a la tabla nueva una sola vez.
  try {
    await db.execute(
      `INSERT INTO reparto_items (reparto_id, descripcion, cantidad, precio_unitario_centavos)
       SELECT r.id, COALESCE(NULLIF(TRIM(r.item_descripcion), ''), 'Carga'),
              COALESCE(r.cantidad, 1), COALESCE(r.item_precio_unitario_centavos, 0)
       FROM repartos r
       WHERE r.lleva_remito = 0 AND r.cantidad IS NOT NULL AND r.cantidad > 0
         AND NOT EXISTS (SELECT 1 FROM reparto_items ri WHERE ri.reparto_id = r.id)`,
    );
  } catch (error) {
    // Bases nuevas no tienen las columnas viejas; no hay nada que migrar.
    const mensaje = String(error);
    if (!mensaje.includes("no such column") && !mensaje.includes("unknown column")) {
      throw error;
    }
  }

  // Los repartos que ya tenían una forma de pago elegida (distinta de la que
  // se preseleccionaba por defecto) se consideran cobrados.
  await db.execute(
    "UPDATE repartos SET cobrado = 1 WHERE forma_pago IN ('cuenta_corriente', 'debito', 'cheque')",
  );

  // Los remitos pasan a pertenecer al reparto (y el cliente sale del reparto):
  // se elimina la columna cliente_id de remitos conservando los datos. Debe
  // correrse después del schema para que las bases nuevas ya vengan sin la
  // columna y no haga nada.
  await reconstruirRepartosSinEstado(db);
  await reconstruirRemitosSinCliente(db);

  // El "estado" ya no existe (ni en repartos ni en remitos): cada día se abre
  // una hoja de ruta y solo importa si el reparto se cobró. Se eliminan las
  // columnas conservando los datos (mismo truco de RENAME que arriba).
  await reconstruirRemitosSinEstado(db);

  // Las reconstrucciones de `repartos` (RENAME) pueden dejar a `reparto_items`
  // apuntando a la tabla vieja ya borrada; se corrige si pasó (idempotente).
  await repararRepartoItems(db);

  // Rol único: el sistema opera solo con administradores. Si quedaron
  // usuarios con rol 'operador' de versiones previas, se los promueve.
  await db.execute("UPDATE usuarios SET rol = 'admin' WHERE rol = 'operador'");
}

/**
 * Reconstruye la tabla `remitos` sin la columna `cliente_id`.
 *
 * Antes el remito se emitía a nombre de un cliente (remitos.cliente_id NOT NULL
 * ON DELETE RESTRICT), lo que impedía borrar clientes con remitos. A partir de
 * acá el remito pertenece a un reparto y el cliente se resuelve a través del
 * reparto, así que la columna se elimina y los datos se conservan.
 *
 * Se hace con un intercambio de tablas (RENAME) y NO se desactiva foreign_keys:
 * Turso por HTTP no permite cambiarlo y el truco funciona igual con las claves
 * activadas. Cada paso se ejecuta en un solo `batch` (atómico en libsql).
 */
async function reconstruirRemitosSinCliente(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<void> {
  const info = await db.execute(
    "SELECT name FROM pragma_table_info('remitos') WHERE name = 'cliente_id'",
  );
  if (info.rows.length === 0) {
    // Ya reconstruida. Si un run anterior quedó a medias, limpiamos restos.
    await db.execute("DROP TABLE IF EXISTS remito_items_viejo");
    await db.execute("DROP TABLE IF EXISTS remitos_viejo");
    return;
  }

  const statements: InStatement[] = [
    // Partimos limpio por si quedó una reconstrucción anterior a medias.
    { sql: "DROP TABLE IF EXISTS remito_items_viejo", args: [] },
    { sql: "DROP TABLE IF EXISTS remitos_viejo", args: [] },
    { sql: "DROP TABLE IF EXISTS remito_items_nuevo", args: [] },
    { sql: "DROP TABLE IF EXISTS remitos_nuevo", args: [] },

    // Tablas nuevas sin `cliente_id` (misma forma que lib/schema.sql).
    {
      sql: `CREATE TABLE remitos_nuevo (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        numero         INTEGER NOT NULL,
        reparto_id     INTEGER REFERENCES repartos(id) ON DELETE SET NULL,
        fecha          TEXT NOT NULL DEFAULT (date('now')),
        estado         TEXT NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('pendiente', 'entregado', 'cancelado')),
        observaciones  TEXT,
        creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (numero)
      )`,
      args: [],
    },
    {
      sql: `CREATE TABLE remito_items_nuevo (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        remito_id                INTEGER NOT NULL REFERENCES remitos_nuevo(id) ON DELETE CASCADE,
        descripcion              TEXT NOT NULL,
        cantidad                 REAL NOT NULL DEFAULT 1 CHECK (cantidad > 0),
        precio_unitario_centavos INTEGER NOT NULL DEFAULT 0 CHECK (precio_unitario_centavos >= 0)
      )`,
      args: [],
    },

    // Copiamos los datos antes de borrar nada (una falla a mitad no pierde nada).
    {
      sql: `INSERT INTO remitos_nuevo (id, numero, reparto_id, fecha, estado, observaciones, creado_en)
            SELECT id, numero, reparto_id, fecha, estado, observaciones, creado_en FROM remitos`,
      args: [],
    },
    {
      sql: `INSERT INTO remito_items_nuevo (id, remito_id, descripcion, cantidad, precio_unitario_centavos)
            SELECT id, remito_id, descripcion, cantidad, precio_unitario_centavos FROM remito_items`,
      args: [],
    },

    // Los índices viejos apuntan a la tabla vieja; se recrean al final.
    { sql: "DROP INDEX IF EXISTS idx_remitos_cliente", args: [] },
    { sql: "DROP INDEX IF EXISTS idx_remitos_reparto", args: [] },
    { sql: "DROP INDEX IF EXISTS idx_remitos_estado_reparto", args: [] },
    { sql: "DROP INDEX IF EXISTS idx_remitos_fecha_estado", args: [] },

    // Intercambio: las viejas se renombran y las nuevas toman su lugar.
    // SQLite actualiza las referencias FK de remito_items hacia los nombres
    // nuevos automáticamente en cada RENAME.
    { sql: "ALTER TABLE remitos RENAME TO remitos_viejo", args: [] },
    { sql: "ALTER TABLE remito_items RENAME TO remito_items_viejo", args: [] },
    { sql: "ALTER TABLE remitos_nuevo RENAME TO remitos", args: [] },
    { sql: "ALTER TABLE remito_items_nuevo RENAME TO remito_items", args: [] },

    // Los datos ya están en las tablas nuevas; limpiamos las Viejas (items
    // primero, para no dejar hijos sin padre).
    { sql: "DROP TABLE remito_items_viejo", args: [] },
    { sql: "DROP TABLE remitos_viejo", args: [] },

    // Índices del nuevo formato (idempotentes como en schema.sql).
    { sql: "CREATE INDEX IF NOT EXISTS idx_remitos_reparto ON remitos(reparto_id)", args: [] },
    { sql: "CREATE INDEX IF NOT EXISTS idx_remitos_estado_reparto ON remitos(estado, reparto_id)", args: [] },
    { sql: "CREATE INDEX IF NOT EXISTS idx_remitos_fecha_estado ON remitos(fecha, estado)", args: [] },
    { sql: "CREATE INDEX IF NOT EXISTS idx_remito_items_remito ON remito_items(remito_id)", args: [] },
  ];

  await db.batch(statements);
}

/**
 * Reconstruye la tabla `repartos` sin la columna `estado`.
 *
 * El "estado" del reparto (pendiente/en curso/completado/cancelado) ya no
 * existe: cada día tiene su hoja de ruta y lo único que se registra es si el
 * reparto se cobró (`cobrado` + `forma_pago`). Mismo intercambio de tablas
 * (RENAME) que `reconstruirRemitosSinCliente`, sin desactivar foreign_keys:
 * SQLite actualiza las referencias de `reparto_items` y `remitos` en cada RENAME.
 */
async function reconstruirRepartosSinEstado(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<void> {
  const info = await db.execute(
    "SELECT name FROM pragma_table_info('repartos') WHERE name = 'estado'",
  );
  if (info.rows.length === 0) {
    // Ya reconstruida. Si un run anterior quedó a medias, limpiamos restos.
    await db.execute("DROP TABLE IF EXISTS repartos_viejo");
    return;
  }

  const statements: InStatement[] = [
    // Partimos limpio por si quedó una reconstrucción anterior a medias.
    { sql: "DROP TABLE IF EXISTS repartos_viejo", args: [] },
    { sql: "DROP TABLE IF EXISTS repartos_nuevo", args: [] },

    // Tabla nueva sin `estado` (misma forma que lib/schema.sql).
    {
      sql: `CREATE TABLE repartos_nuevo (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha         TEXT NOT NULL DEFAULT (date('now')),
        cliente_id    INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
        lleva_remito  INTEGER NOT NULL DEFAULT 0,
        forma_pago    TEXT NOT NULL DEFAULT 'contado'
                      CHECK (forma_pago IN ('contado', 'cuenta_corriente', 'debito', 'cheque')),
        cobrado       INTEGER NOT NULL DEFAULT 0,
        chofer        TEXT,
        vehiculo      TEXT,
        notas         TEXT,
        creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      args: [],
    },

    // Copiamos los datos antes de borrar nada (una falla a mitad no pierde nada).
    {
      sql: `INSERT INTO repartos_nuevo (id, fecha, cliente_id, lleva_remito, forma_pago,
                                        cobrado, chofer, vehiculo, notas, creado_en)
            SELECT id, fecha, cliente_id, lleva_remito, forma_pago,
                   cobrado, chofer, vehiculo, notas, creado_en FROM repartos`,
      args: [],
    },

    // Los índices viejos apuntan a la tabla vieja; se recrean al final.
    { sql: "DROP INDEX IF EXISTS idx_repartos_fecha", args: [] },
    { sql: "DROP INDEX IF EXISTS idx_repartos_cliente", args: [] },
    { sql: "DROP INDEX IF EXISTS idx_repartos_cliente_cobrado_estado", args: [] },

    // Intercambio: la vieja se renombra y la nueva toma su lugar.
    { sql: "ALTER TABLE repartos RENAME TO repartos_viejo", args: [] },
    { sql: "ALTER TABLE repartos_nuevo RENAME TO repartos", args: [] },

    // Los datos ya están en la tabla nueva; limpiamos la vieja.
    { sql: "DROP TABLE repartos_viejo", args: [] },

    // Índices del nuevo formato (idempotentes como en schema.sql).
    { sql: "CREATE INDEX IF NOT EXISTS idx_repartos_fecha ON repartos(fecha)", args: [] },
    { sql: "CREATE INDEX IF NOT EXISTS idx_repartos_cliente ON repartos(cliente_id)", args: [] },
    { sql: "CREATE INDEX IF NOT EXISTS idx_repartos_cliente_cobrado ON repartos(cliente_id, cobrado)", args: [] },
  ];

  await db.batch(statements);
}

/**
 * Reconstruye la tabla `remitos` sin la columna `estado`.
 *
 * El remito ya no tiene "entregado / no entregado". Se copian los datos
 * (remitos + remito_items) y se vuelve a armar la tabla sin la columna.
 */
async function reconstruirRemitosSinEstado(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<void> {
  const info = await db.execute(
    "SELECT name FROM pragma_table_info('remitos') WHERE name = 'estado'",
  );
  if (info.rows.length === 0) {
    // Ya reconstruida. Si un run anterior quedó a medias, limpiamos restos.
    await db.execute("DROP TABLE IF EXISTS remito_items_viejo");
    await db.execute("DROP TABLE IF EXISTS remitos_viejo");
    return;
  }

  const statements: InStatement[] = [
    // Partimos limpio por si quedó una reconstrucción anterior a medias.
    { sql: "DROP TABLE IF EXISTS remito_items_viejo", args: [] },
    { sql: "DROP TABLE IF EXISTS remitos_viejo", args: [] },
    { sql: "DROP TABLE IF EXISTS remito_items_nuevo", args: [] },
    { sql: "DROP TABLE IF EXISTS remitos_nuevo", args: [] },

    // Tablas nuevas sin `estado` (misma forma que lib/schema.sql).
    {
      sql: `CREATE TABLE remitos_nuevo (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        numero         INTEGER NOT NULL,
        reparto_id     INTEGER REFERENCES repartos(id) ON DELETE SET NULL,
        fecha          TEXT NOT NULL DEFAULT (date('now')),
        observaciones  TEXT,
        creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (numero)
      )`,
      args: [],
    },
    {
      sql: `CREATE TABLE remito_items_nuevo (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        remito_id                INTEGER NOT NULL REFERENCES remitos_nuevo(id) ON DELETE CASCADE,
        descripcion              TEXT NOT NULL,
        cantidad                 REAL NOT NULL DEFAULT 1 CHECK (cantidad > 0),
        precio_unitario_centavos INTEGER NOT NULL DEFAULT 0 CHECK (precio_unitario_centavos >= 0)
      )`,
      args: [],
    },

    // Copiamos los datos antes de borrar nada (una falla a mitad no pierde nada).
    {
      sql: `INSERT INTO remitos_nuevo (id, numero, reparto_id, fecha, observaciones, creado_en)
            SELECT id, numero, reparto_id, fecha, observaciones, creado_en FROM remitos`,
      args: [],
    },
    {
      sql: `INSERT INTO remito_items_nuevo (id, remito_id, descripcion, cantidad, precio_unitario_centavos)
            SELECT id, remito_id, descripcion, cantidad, precio_unitario_centavos FROM remito_items`,
      args: [],
    },

    // Los índices viejos apuntan a la tabla vieja; se recrean al final.
    { sql: "DROP INDEX IF EXISTS idx_remitos_reparto", args: [] },
    { sql: "DROP INDEX IF EXISTS idx_remitos_estado_reparto", args: [] },
    { sql: "DROP INDEX IF EXISTS idx_remitos_fecha_estado", args: [] },
    { sql: "DROP INDEX IF EXISTS idx_remitos_fecha", args: [] },

    // Intercambio: las viejas se renombran y las nuevas toman su lugar.
    { sql: "ALTER TABLE remitos RENAME TO remitos_viejo", args: [] },
    { sql: "ALTER TABLE remito_items RENAME TO remito_items_viejo", args: [] },
    { sql: "ALTER TABLE remitos_nuevo RENAME TO remitos", args: [] },
    { sql: "ALTER TABLE remito_items_nuevo RENAME TO remito_items", args: [] },

    { sql: "DROP TABLE remito_items_viejo", args: [] },
    { sql: "DROP TABLE remitos_viejo", args: [] },

    // Índices del nuevo formato (idempotentes como en schema.sql).
    { sql: "CREATE INDEX IF NOT EXISTS idx_remitos_reparto ON remitos(reparto_id)", args: [] },
    { sql: "CREATE INDEX IF NOT EXISTS idx_remitos_fecha ON remitos(fecha)", args: [] },
    { sql: "CREATE INDEX IF NOT EXISTS idx_remito_items_remito ON remito_items(remito_id)", args: [] },
  ];

  await db.batch(statements);
}

/**
 * Repara la clave foránea de `reparto_items` si quedó apuntando a una tabla
 * que ya no existe. Pasó en bases viejas: al reconstruir `repartos` con
 * RENAME (`repartos_viejo` → `repartos`), SQLite actualizó la referencia de
 * `reparto_items` apuntándola al nombre viejo, que después se borró. Desde
 * entonces cualquier INSERT de mercadería directa fallaba con
 * "no such table: main.repartos_viejo" (el guardado del reparto daba error).
 *
 * Idempotente: si la FK ya apunta a `repartos(id)`, no toca nada.
 */
async function repararRepartoItems(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<void> {
  const resultado = await db.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reparto_items'",
  );
  if (resultado.rows.length === 0) return;
  const sql = String((resultado.rows[0] as Record<string, unknown>).sql ?? "");

  const referencias = [...sql.matchAll(/REFERENCES\s+(?:"([^"]+)"|([\w]+))\(/g)];
  const tablasReferenciadas = referencias.map((m) => m[1] ?? m[2]);
  const apuntaMal = tablasReferenciadas.filter(
    (tabla) => tabla !== "repartos",
  );
  if (apuntaMal.length === 0) return;

  const statements: InStatement[] = [
    { sql: "DROP TABLE IF EXISTS reparto_items_viejo", args: [] },
    { sql: "DROP TABLE IF EXISTS reparto_items_nuevo", args: [] },
    {
      sql: `CREATE TABLE reparto_items_nuevo (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        reparto_id              INTEGER NOT NULL REFERENCES repartos(id) ON DELETE CASCADE,
        descripcion             TEXT NOT NULL,
        cantidad                REAL NOT NULL DEFAULT 1 CHECK (cantidad > 0),
        precio_unitario_centavos INTEGER NOT NULL DEFAULT 0 CHECK (precio_unitario_centavos >= 0)
      )`,
      args: [],
    },
    {
      sql: `INSERT INTO reparto_items_nuevo (id, reparto_id, descripcion, cantidad, precio_unitario_centavos)
            SELECT id, reparto_id, descripcion, cantidad, precio_unitario_centavos FROM reparto_items`,
      args: [],
    },
    { sql: "DROP INDEX IF EXISTS idx_reparto_items_reparto", args: [] },
    { sql: "ALTER TABLE reparto_items RENAME TO reparto_items_viejo", args: [] },
    { sql: "ALTER TABLE reparto_items_nuevo RENAME TO reparto_items", args: [] },
    { sql: "DROP TABLE reparto_items_viejo", args: [] },
    {
      sql: "CREATE INDEX IF NOT EXISTS idx_reparto_items_reparto ON reparto_items(reparto_id)",
      args: [],
    },
  ];
  await db.batch(statements);
}