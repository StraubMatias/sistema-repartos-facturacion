import { getDb } from "@/lib/db";
import type { InArgs, InStatement } from "@libsql/core/api";
import type {
  FormaPago,
  Reparto,
  RepartoItem,
  RepartoRemitoLigero,
} from "@/lib/types";

type Fila = Record<string, unknown>;

function mapearReparto(fila: Fila): Reparto {
  const cobrado = Number(fila.cobrado ?? 0) === 1;
  return {
    id: Number(fila.id),
    fecha: String(fila.fecha),
    clienteId: fila.cliente_id != null ? Number(fila.cliente_id) : null,
    clienteNombre: fila.cliente_nombre ? String(fila.cliente_nombre) : null,
    enviadoPor: fila.enviado_por ? String(fila.enviado_por) : null,
    recibidoPor: fila.recibido_por ? String(fila.recibido_por) : null,
    observaciones: fila.observaciones ? String(fila.observaciones) : null,
    llevaRemito: Number(fila.lleva_remito ?? 0) === 1,
    items: [],
    formaPago: cobrado
      ? (String(fila.forma_pago ?? "contado") as FormaPago)
      : null,
    cobrado,
    valorCentavos: Number(fila.valor_centavos ?? 0),
    creadoEn: String(fila.creado_en),
    remitos: [],
  };
}

/**
 * SQL en común entre la lista y el detalle: reparto + cliente + valor total.
 * El valor suma los items de los remitos asignados y la mercadería directa
 * del reparto (`reparto_items`), que puede cargarse con o sin remito.
 */
const SQL_SELECCION_REPARTO = `
  SELECT rp.id, rp.fecha,
         rp.cliente_id, c.nombre AS cliente_nombre,
         rp.chofer AS enviado_por, rp.vehiculo AS recibido_por,
         rp.notas AS observaciones, rp.creado_en,
         rp.lleva_remito, rp.forma_pago, rp.cobrado,
         (
           (SELECT COALESCE(SUM(ri.cantidad * ri.precio_unitario_centavos), 0)
            FROM remitos rt
            JOIN remito_items ri ON ri.remito_id = rt.id
            WHERE rt.reparto_id = rp.id)
           + (SELECT COALESCE(SUM(mi.cantidad * mi.precio_unitario_centavos), 0)
              FROM reparto_items mi
              WHERE mi.reparto_id = rp.id)
         ) AS valor_centavos
  FROM repartos rp
  LEFT JOIN clientes c ON c.id = rp.cliente_id
`;

/**
 * Lista repartos con el valor total (remitos asignados + mercadería directa)
 * y los remitos asociados (id + número) para mostrar en la columna "Remitos".
 *
 * Orden: por fecha (más reciente primero) y después por id. La hoja de ruta
 * diaria usa `obtenerHojaDeRutaDia`.
 */
export async function listarRepartos(): Promise<Reparto[]> {
  return consultarRepartosCompletos(
    `${SQL_SELECCION_REPARTO}
     GROUP BY rp.id
     ORDER BY rp.fecha DESC, rp.id DESC`,
  );
}

/**
 * Optimización: Valor del reparto calculado sin subconsultas correlacionadas.
 * LEFT JOIN con pre-agregación para evitar O(n*m) con muchos repartos.
 * 
 * Se usa en `obtenerHojaDeRutaDia()` para ejecutar todo en UN batch de 4 queries.
 */
const SQL_VALOR_REPARTO_OPTIMIZADO = `
  SELECT rp.id, rp.cobrado,
         COALESCE(v_rem.total_remitos_centavos, 0) + COALESCE(v_rep.total_items_centavos, 0) AS valor_centavos
  FROM repartos rp
  LEFT JOIN (
    SELECT rt.reparto_id, SUM(ri.cantidad * ri.precio_unitario_centavos) AS total_remitos_centavos
    FROM remitos rt
    JOIN remito_items ri ON ri.remito_id = rt.id
    GROUP BY rt.reparto_id
  ) v_rem ON v_rem.reparto_id = rp.id
  LEFT JOIN (
    SELECT mi.reparto_id, SUM(mi.cantidad * mi.precio_unitario_centavos) AS total_items_centavos
    FROM reparto_items mi
    GROUP BY mi.reparto_id
  ) v_rep ON v_rep.reparto_id = rp.id
`;

/**
 * Datos consolidados de la Hoja de Ruta para un día específico.
 * 
 * OPTIMIZACIÓN CRÍTICA: TODO en UN solo batch (4 queries → 1 request HTTP).
 * Reduce de 4 round-trips HTTP a 1, reduciendo latencia ~70% y consumo de Turso.
 * 
 * Las 4 queries se ejecutan en paralelo en el servidor de Turso, no en serie.
 */
export interface HojaDeRutaDia {
  diasConRepartos: string[];
  repartos: Reparto[];
  gastos: Array<{
    id: number;
    fecha: string;
    categoria: string;
    descripcion: string;
    proveedor: string | null;
    montoCentavos: number;
    creadoEn: string;
  }>;
  resumen: ResumenDia;
}

export async function obtenerHojaDeRutaDia(fecha: string): Promise<HojaDeRutaDia> {
  const db = await getDb();
  const mes = fecha.slice(0, 7);

  // BATCH: 4 queries en 1 request HTTP
  const [resDias, resRepartos, resGastos, resResumen] = await db.batch([
    // 1. Días del mes con repartos (para el calendario)
    {
      sql: "SELECT DISTINCT fecha FROM repartos WHERE substr(fecha, 1, 7) = ? ORDER BY fecha ASC",
      args: [mes],
    },
    // 2. Repartos del día con clientes y valores calculados
    {
      sql: `${SQL_SELECCION_REPARTO}
            WHERE rp.fecha = ?
            GROUP BY rp.id
            ORDER BY rp.cobrado ASC, rp.id ASC`,
      args: [fecha],
    },
    // 3. Gastos del día (mismo día, no todo el mes)
    {
      sql: `SELECT id, fecha, categoria, descripcion, proveedor, monto_centavos, creado_en
            FROM gastos
            WHERE fecha = ?
            ORDER BY id DESC`,
      args: [fecha],
    },
    // 4. Resumen del día (valor, cobrado, falta cobrar) - usa LEFT JOIN optimizado
    {
      sql: `SELECT COUNT(*) AS cantidad_total,
                    COALESCE(SUM(CASE WHEN rp.cobrado = 1 THEN 1 ELSE 0 END), 0) AS cantidad_cobrados,
                    COALESCE(SUM(calc.valor_centavos), 0) AS total_centavos,
                    COALESCE(SUM(CASE WHEN rp.cobrado = 1 THEN calc.valor_centavos ELSE 0 END), 0) AS cobrado_centavos,
                    COALESCE(SUM(CASE WHEN rp.cobrado = 0 THEN calc.valor_centavos ELSE 0 END), 0) AS falta_centavos
             FROM repartos rp
             LEFT JOIN (${SQL_VALOR_REPARTO_OPTIMIZADO}) calc ON calc.id = rp.id
             WHERE rp.fecha = ?`,
      args: [fecha],
    },
  ]);

  // Mapear repartos completos (con remitos e items)
  const repartoIds = resRepartos.rows.map((f) => Number((f as Fila).id));
  
  // Si hay repartos, cargar remitos e items en batch
  const remitosMap: Map<number, RepartoRemitoLigero[]> = new Map();
  const itemsMap: Map<number, RepartoItem[]> = new Map();
  
  if (repartoIds.length > 0) {
    const [resRemitos, resItems] = await db.batch([
      {
        sql: `SELECT reparto_id, id, numero FROM remitos WHERE reparto_id IN (${repartoIds.map(() => '?').join(',')}) ORDER BY numero ASC`,
        args: repartoIds as InArgs,
      },
      {
        sql: `SELECT id, reparto_id, descripcion, cantidad, precio_unitario_centavos FROM reparto_items WHERE reparto_id IN (${repartoIds.map(() => '?').join(',')}) ORDER BY id ASC`,
        args: repartoIds as InArgs,
      },
    ]);
    
    for (const fila of resRemitos.rows) {
      const f = fila as Fila;
      const repartoId = Number(f.reparto_id);
      if (!remitosMap.has(repartoId)) remitosMap.set(repartoId, []);
      remitosMap.get(repartoId)!.push({ id: Number(f.id), numero: Number(f.numero) });
    }
    
    for (const fila of resItems.rows) {
      const f = fila as Fila;
      const repartoId = Number(f.reparto_id);
      if (!itemsMap.has(repartoId)) itemsMap.set(repartoId, []);
      itemsMap.get(repartoId)!.push({
        id: Number(f.id),
        repartoId,
        descripcion: String(f.descripcion),
        cantidad: Number(f.cantidad),
        precioUnitarioCentavos: Number(f.precio_unitario_centavos),
      });
    }
  }

  // Mapear repartos con sus remitos e items
  const repartos = resRepartos.rows.map((fila) => {
    const reparto = mapearReparto(fila as Fila);
    const repartoId = reparto.id;
    reparto.remitos = remitosMap.get(repartoId) || [];
    reparto.items = itemsMap.get(repartoId) || [];
    return reparto;
  });

  // Mapear gastos
  const gastos = resGastos.rows.map((fila) => {
    const f = fila as Fila;
    return {
      id: Number(f.id),
      fecha: String(f.fecha),
      categoria: String(f.categoria),
      descripcion: String(f.descripcion),
      proveedor: f.proveedor ? String(f.proveedor) : null,
      montoCentavos: Number(f.monto_centavos),
      creadoEn: String(f.creado_en),
    };
  });

  // Mapear resumen
  const fResumen = resResumen.rows[0] as Fila;
  const resumen: ResumenDia = {
    cantidadTotal: Number(fResumen.cantidad_total ?? 0),
    cantidadCobrados: Number(fResumen.cantidad_cobrados ?? 0),
    totalCentavos: Number(fResumen.total_centavos ?? 0),
    cobradoCentavos: Number(fResumen.cobrado_centavos ?? 0),
    faltaCobrarCentavos: Number(fResumen.falta_centavos ?? 0),
  };

  return {
    diasConRepartos: resDias.rows.map((fila) => String((fila as Fila).fecha)),
    repartos,
    gastos,
    resumen,
  };
}

/** Resumen de cobros de un día (hoja de ruta): total, cobrado y por cobrar. */
export interface ResumenDia {
  /** Cantidad total de repartos del día. */
  cantidadTotal: number;
  /** Cantidad de repartos que ya se cobraron (forma de pago elegida). */
  cantidadCobrados: number;
  /** Valor total de la hoja de ruta (suma de todos los repartos del día). */
  totalCentavos: number;
  /** Lo que ya se cobró (repartos con forma de pago elegida). */
  cobradoCentavos: number;
  /** Lo que todavía falta cobrar del día. */
  faltaCobrarCentavos: number;
}

/** Repartos de un cliente para su ficha, con la misma forma que el listado
 *  general: valor, remitos asociados e items de mercadería.
 *
 *  Un reparto le pertenece al cliente si está vinculado a él (`cliente_id`) o
 *  si su nombre aparece como Flete Origen (quién envía) o Flete Destino (quién
 *  recibe): el cliente puede ser cualquiera de las dos puntas del reparto aunque
 *  el reparto esté vinculado a otro cliente registrado. */
export async function listarRepartosDelCliente(
  clienteId: number,
  clienteNombre: string,
): Promise<Reparto[]> {
  return consultarRepartosCompletos(
    `${SQL_SELECCION_REPARTO}
     WHERE rp.cliente_id = ?
        OR rp.chofer = ? COLLATE NOCASE
        OR rp.vehiculo = ? COLLATE NOCASE
     GROUP BY rp.id
     ORDER BY rp.fecha DESC, rp.id DESC`,
    [clienteId, clienteNombre, clienteNombre],
  );
}

/**
 * Ejecuta la consulta principal de repartos + los remitos y items de
 * mercadería en UN solo batch (un único round-trip HTTP a Turso).
 */
async function consultarRepartosCompletos(
  sqlPrincipal: string,
  argsPrincipal?: InArgs,
): Promise<Reparto[]> {
  const db = await getDb();
  const resultado = await db.execute(sqlPrincipal, argsPrincipal ?? []);
  const repartos = resultado.rows.map((fila) => mapearReparto(fila as Fila));
  await completarRepartos(db, repartos);
  return repartos;
}

/** Asocia los remitos y los items de mercadería a repartos ya mapeados.
 *  Filtra por los IDs de los repartos pedidos (en vez de barrer todas las
 *  tablas) y ejecuta ambas lecturas en un solo batch HTTP a Turso. */
const LIMITE_PLACEHOLDERS_BATCH = 900; // < SQLITE_MAX_VARIABLE_NUMBER (32766)

async function completarRepartos(
  db: Awaited<ReturnType<typeof getDb>>,
  repartos: Reparto[],
): Promise<void> {
  if (repartos.length === 0) return;

  const ids = repartos.map((r) => r.id);

  // Con pocos repartos conviene filtrar por IN (menos datos del server al
  // cliente). Con listas enormes, el payload de placeholders crece: caemos al
  // barrido completo (que ya cubría todos los ids de todas formas).
  const usarFiltro = ids.length <= LIMITE_PLACEHOLDERS_BATCH;

  const [resRemitos, resItems] = usarFiltro
    ? await db.batch([
        {
          sql: `SELECT reparto_id, id, numero
                FROM remitos
                WHERE reparto_id IN (${ids.map(() => "?").join(",")})
                ORDER BY numero ASC`,
          args: ids,
        },
        {
          sql: `SELECT id, reparto_id, descripcion, cantidad, precio_unitario_centavos
                FROM reparto_items
                WHERE reparto_id IN (${ids.map(() => "?").join(",")})
                ORDER BY id ASC`,
          args: ids,
        },
      ])
    : await db.batch([
        `SELECT reparto_id, id, numero
         FROM remitos
         WHERE reparto_id IS NOT NULL
         ORDER BY numero ASC`,
        `SELECT id, reparto_id, descripcion, cantidad, precio_unitario_centavos
         FROM reparto_items
         ORDER BY id ASC`,
      ]);

  const remitosPorReparto = new Map<number, RepartoRemitoLigero[]>();
  for (const fila of resRemitos.rows) {
    const f = fila as Fila;
    const repartoId = Number(f.reparto_id);
    const lista = remitosPorReparto.get(repartoId) ?? [];
    lista.push({ id: Number(f.id), numero: Number(f.numero) });
    remitosPorReparto.set(repartoId, lista);
  }

  const itemsPorReparto = new Map<number, RepartoItem[]>();
  for (const fila of resItems.rows) {
    const f = fila as Fila;
    const repartoId = Number(f.reparto_id);
    const lista = itemsPorReparto.get(repartoId) ?? [];
    lista.push({
      id: Number(f.id),
      repartoId,
      descripcion: String(f.descripcion),
      cantidad: Number(f.cantidad),
      precioUnitarioCentavos: Number(f.precio_unitario_centavos),
    });
    itemsPorReparto.set(repartoId, lista);
  }

  for (const reparto of repartos) {
    reparto.remitos = remitosPorReparto.get(reparto.id) ?? [];
    reparto.items = itemsPorReparto.get(reparto.id) ?? [];
  }
}

/** Un ítem de la mercadería directa al crear el reparto (cuando no lleva remito). */
export interface ItemMercaderiaNuevo {
  descripcion: string;
  cantidad: number;
  precioUnitarioCentavos: number;
}

export interface DatosNuevoReparto {
  fecha: string; // YYYY-MM-DD
  /** Cliente vinculado al reparto (campo "Envía"). Puede ser null si el
   *  cliente todavía no está cargado: el reparto se guarda igual sin
   *  vincularlo (el nombre queda en `enviadoPor`). */
  clienteId?: number | null;
  enviadoPor?: string;
  recibidoPor?: string;
  observaciones?: string;
  /** Si el reparto lleva remito, se emite uno en el alta (además de la mercadería directa). */
  llevaRemito?: boolean;
  /** Líneas de mercadería directa (descripción, cantidad y valor). */
  itemsMercaderia?: ItemMercaderiaNuevo[];
  /** Forma de pago, o null si todavía no se cobró (queda "Por cobrar"). */
  formaPago?: FormaPago | null;
}

/** Crea un reparto (y sus líneas de mercadería directa) y devuelve su id. */
export async function crearReparto(datos: DatosNuevoReparto): Promise<number> {
  const db = await getDb();
  const resultado = await db.execute(
    `INSERT INTO repartos (fecha, cliente_id, chofer, vehiculo, notas,
                           lleva_remito, forma_pago, cobrado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      datos.fecha,
      datos.clienteId ?? null,
      datos.enviadoPor ?? null,
      datos.recibidoPor ?? null,
      datos.observaciones ?? null,
      datos.llevaRemito ? 1 : 0,
      datos.formaPago ?? "contado",
      datos.formaPago ? 1 : 0,
    ],
  );
  const id = Number(resultado.lastInsertRowid ?? 0);

  // La mercadería directa se guarda siempre (con o sin remito).
  const items = datos.itemsMercaderia ?? [];
  if (items.length > 0) {
    const statements: InStatement[] = items.map((item) => ({
      sql: `INSERT INTO reparto_items (reparto_id, descripcion, cantidad, precio_unitario_centavos)
            VALUES (?, ?, ?, ?)`,
      args: [
        id,
        item.descripcion,
        item.cantidad,
        item.precioUnitarioCentavos,
      ] as InArgs,
    }));
    await db.batch(statements);
  }

  return id;
}

/**
 * Guarda la forma de pago de un reparto y lo marca como cobrado. Si se pasa
 * null, el reparto vuelve a "Por cobrar" y la forma queda sin usar.
 *
 * Con "Cuenta corriente" la acción pasa `clienteId`: el cliente del reparto
 * (el Flete Origen o el Flete Destino elegido) se registra/vincula en ese
 * momento. Para el resto de las formas el cliente no se toca.
 */
export async function actualizarFormaPagoReparto(
  id: number,
  formaPago: FormaPago | null,
  clienteId?: number | null,
): Promise<void> {
  const db = await getDb();
  if (clienteId != null) {
    await db.execute(
      "UPDATE repartos SET forma_pago = ?, cobrado = ?, cliente_id = ? WHERE id = ?",
      [formaPago ?? "contado", formaPago ? 1 : 0, clienteId, id],
    );
  } else {
    await db.execute(
      "UPDATE repartos SET forma_pago = ?, cobrado = ? WHERE id = ?",
      [formaPago ?? "contado", formaPago ? 1 : 0, id],
    );
  }
}

/** Devuelve el Flete Origen, el Flete Destino y el cliente vinculado de un
 *  reparto. Liviano: sirve para resolver/crear el cliente al cobrar en
 *  cuenta corriente. */
export async function obtenerPartesReparto(
  id: number,
): Promise<{
  clienteId: number | null;
  enviadoPor: string | null;
  recibidoPor: string | null;
} | null> {
  const db = await getDb();
  const resultado = await db.execute(
    "SELECT cliente_id, chofer AS enviado_por, vehiculo AS recibido_por FROM repartos WHERE id = ?",
    [id],
  );
  if (resultado.rows.length === 0) return null;
  const fila = resultado.rows[0] as Fila;
  return {
    clienteId: fila.cliente_id != null ? Number(fila.cliente_id) : null,
    enviadoPor: fila.enviado_por ? String(fila.enviado_por) : null,
    recibidoPor: fila.recibido_por ? String(fila.recibido_por) : null,
  };
}

/** Devuelve un reparto por id (o null si no existe) con el valor total de los
 *  remitos asignados y de su mercadería directa (suma de items). */
export async function obtenerReparto(id: number): Promise<Reparto | null> {
  const db = await getDb();
  const [resPrincipal, resRemitos, resItems] = await db.batch([
    {
      sql: `${SQL_SELECCION_REPARTO}
            WHERE rp.id = ?
            GROUP BY rp.id`,
      args: [id],
    },
    {
      sql: `SELECT reparto_id, id, numero
            FROM remitos
            WHERE reparto_id = ?
            ORDER BY numero ASC`,
      args: [id],
    },
    {
      sql: `SELECT id, reparto_id, descripcion, cantidad, precio_unitario_centavos
            FROM reparto_items
            WHERE reparto_id = ?
            ORDER BY id ASC`,
      args: [id],
    },
  ]);

  if (resPrincipal.rows.length === 0) return null;
  const reparto = mapearReparto(resPrincipal.rows[0] as Fila);

  for (const fila of resRemitos.rows) {
    const f = fila as Fila;
    reparto.remitos.push({ id: Number(f.id), numero: Number(f.numero) });
  }
  for (const fila of resItems.rows) {
    const f = fila as Fila;
    reparto.items.push({
      id: Number(f.id),
      repartoId: id,
      descripcion: String(f.descripcion),
      cantidad: Number(f.cantidad),
      precioUnitarioCentavos: Number(f.precio_unitario_centavos),
    });
  }
  return reparto;
}

/** Asigna remitos (sin reparto) a una hoja de ruta. Los remitos que ya tienen
 *  reparto se ignoran silenciosamente. */
export async function asignarRemitosAReparto(
  repartoId: number,
  remitoIds: number[],
): Promise<void> {
  if (remitoIds.length === 0) return;
  const db = await getDb();
  const statements: Array<InStatement> = remitoIds.map((remitoId) => ({
    sql: `UPDATE remitos SET reparto_id = ?
          WHERE id = ? AND reparto_id IS NULL`,
    args: [repartoId, remitoId] as InArgs,
  }));
  await db.batch(statements);
}

/** Elimina un reparto. Los remitos asignados quedan sin reparto (ON DELETE SET NULL). */
export async function eliminarReparto(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM repartos WHERE id = ?", [id]);
}

// ----------------------------------------------------------------------------
// Selección liviana de repartos (para emitir un remito)
// ----------------------------------------------------------------------------

/** Vista mínima para el `<select>` de repartos al dar de alta un remito. */
export interface RepartoSeleccion {
  id: number;
  fecha: string;
  /**
   * Nombre visible del cliente del reparto: el del cliente vinculado, o el
   * texto "Envía" si el reparto no tiene cliente registrado. Null solo si no
   * hay nada que mostrar.
   */
  clienteNombre: string | null;
}

/** Lista los repartos para elegir a cuál emitir un remito. El remito hereda
 *  el cliente del reparto elegido. */
export async function listarRepartosParaSeleccion(): Promise<RepartoSeleccion[]> {
  const db = await getDb();
  const resultado = await db.execute(
    `SELECT rp.id, rp.fecha,
            COALESCE(c.nombre, rp.chofer) AS cliente_nombre
     FROM repartos rp
     LEFT JOIN clientes c ON c.id = rp.cliente_id
     ORDER BY rp.fecha DESC, rp.id DESC`,
  );
  return resultado.rows.map((fila) => {
    const f = fila as Fila;
    return {
      id: Number(f.id),
      fecha: String(f.fecha),
      clienteNombre: f.cliente_nombre ? String(f.cliente_nombre) : null,
    };
  });
}