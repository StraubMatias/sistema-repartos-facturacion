/**
 * Tipos de dominio del sistema y utilidades de formato.
 *
 * Convención de dinero: los montos se guardan SIEMPRE en centavos (INTEGER)
 * para evitar errores de redondeo de punto flotante.
 */

// ----------------------------------------------------------------------------
// Clientes
// ----------------------------------------------------------------------------
export interface Cliente {
  id: number;
  /**
   * N° del cliente: SIEMPRE es igual al `id`. Se asigna solo en el alta
   * (no se puede editar); la migración mantiene la sincronización.
   */
  numero: number | null;
  nombre: string;
  cuit: string | null;
  direccion: string | null;
  localidad: string | null;
  telefono: string | null;
  email: string | null;
  notas: string | null;
  /** Todos los clientes registrados operan en cuenta corriente (clientes fijos). */
  esCuentaCorriente: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

// ----------------------------------------------------------------------------
// Gastos
// ----------------------------------------------------------------------------
export const CATEGORIAS_GASTO = [
  "combustible",
  "mecanico",
  "insumos",
  "otros",
] as const;

export type CategoriaGasto = (typeof CATEGORIAS_GASTO)[number];

export const ETIQUETA_CATEGORIA: Record<CategoriaGasto, string> = {
  combustible: "Combustible",
  mecanico: "Mecánico",
  insumos: "Insumos",
  otros: "Otros",
};

export interface Gasto {
  id: number;
  fecha: string; // YYYY-MM-DD
  categoria: CategoriaGasto;
  descripcion: string;
  proveedor: string | null;
  montoCentavos: number;
  creadoEn: string;
}

// ----------------------------------------------------------------------------
// Repartos y remitos (base para el módulo de hojas de ruta)
//
// Ya no existe "estado" ni "entregado/completado": cada día tiene su hoja de
// ruta (los repartos de esa fecha) y lo que importa es si el reparto se cobró
// (`cobrado` + `formaPago`) o todavía falta cobrar.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Formas de pago de los repartos
// ----------------------------------------------------------------------------
export const FORMAS_PAGO = [
  "contado",
  "cuenta_corriente",
  "debito",
  "cheque",
] as const;

export type FormaPago = (typeof FORMAS_PAGO)[number];

export const ETIQUETA_FORMA_PAGO: Record<FormaPago, string> = {
  contado: "Contado",
  cuenta_corriente: "Cuenta corriente",
  debito: "Transferencia",
  cheque: "Cheque",
};

/** Remito resumido que se muestra dentro de un reparto (columna "Remitos"). */
export interface RepartoRemitoLigero {
  id: number;
  numero: number;
}

export interface Reparto {
  id: number;
  fecha: string;
  /** Cliente vinculado al reparto (Flete Origen o Flete Destino), o null si es un reparto viejo. */
  clienteId: number | null;
  /** Nombre del cliente vinculado, para mostrar directo en listas. */
  clienteNombre: string | null;
  /** Quién envía / entrega el reparto (columna `chofer` en la DB). */
  enviadoPor: string | null;
  /** Quién recibe el reparto (columna `vehiculo` en la DB). */
  recibidoPor: string | null;
  /** Observaciones del reparto (columna `notas` en la DB). */
  observaciones: string | null;
  /** Indica si el reparto lleva remito (se emite al darlo de alta). */
  llevaRemito: boolean;
  /** Ítems de la mercadería directa del reparto (con o sin remito). */
  items: RepartoItem[];
  /**
   * Forma de pago elegida, o null si el reparto todavía no se cobró
   * (columna `forma_pago` más `cobrado` en la DB).
   */
  formaPago: FormaPago | null;
  /** True si el reparto ya se cobró (se eligió una forma de pago). */
  cobrado: boolean;
  /**
   * Valor total en centavos: suma de los remitos asignados + la mercadería
   * directa del reparto.
   */
  valorCentavos: number;
  creadoEn: string;
  /** Remitos asociados (solo id + número), poblados en `listarRepartos`. */
  remitos: RepartoRemitoLigero[];
}

/** Ítem de la mercadería directa de un reparto (una línea de `reparto_items`). */
export interface RepartoItem {
  id: number;
  repartoId: number;
  descripcion: string;
  cantidad: number;
  precioUnitarioCentavos: number;
}

export interface Remito {
  id: number;
  numero: number;
  /**
   * Reparto al que pertenece el remito. El cliente del remito es el del
   * reparto (repartos.cliente_id -> clientes): el remito no tiene cliente
   * propio, para que borrar un cliente nunca quede bloqueado por remitos.
   */
  repartoId: number | null;
  fecha: string;
  observaciones: string | null;
  /** Suma del valor de sus items, en centavos. */
  valorCentavos: number;
  creadoEn: string;
}

export interface RemitoItem {
  id: number;
  remitoId: number;
  descripcion: string;
  cantidad: number;
  precioUnitarioCentavos: number;
}

/**
 * Formatea un entero como kilometraje argentino: 12345 → "12.345 km".
 */
export function formatKilometros(km: number): string {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(km) + " km";
}

// ----------------------------------------------------------------------------
// Vehículos (flota propia)
// ----------------------------------------------------------------------------
export interface Vehiculo {
  id: number;
  nombre: string;
  patente: string | null;
  marca: string | null;
  modelo: string | null;
  anio: number | null;
  kilometros: number | null;
  kmProximoService: number | null;
  fechaUltimoService: string | null;
  notas: string | null;
  creadoEn: string;
  actualizadoEn: string;
}

// ----------------------------------------------------------------------------
// Usuarios y sesión
// ----------------------------------------------------------------------------
export type RolUsuario = "admin" | "operador";

export interface Usuario {
  id: number;
  nombre: string;
  passwordHash: string;
  rol: RolUsuario;
  creadoEn: string;
  actualizadoEn: string;
}

/** Datos de sesión visibles para la UI (nunca el password). */
export interface UsuarioSesion {
  id: number;
  nombre: string;
  rol: RolUsuario;
}

// ----------------------------------------------------------------------------
// Utilidades de dinero y fechas
// ----------------------------------------------------------------------------

/** Formatea un valor en centavos a pesos argentinos, ej: 12345 -> "$ 123,45". */
export function formatPesos(centavos: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
  }).format(centavos / 100);
}

/**
 * Convierte un string de pesos a centavos. Formato esperado argentino:
 * la coma es el separador decimal y los puntos actúan como separador de
 * miles (se eliminan), ej: "1.234,56" -> 123456.
 * Devuelve 0 si el valor está vacío, es inválido o negativo.
 */
export function pesosACentavos(valor: string): number {
  const normalizado = valor.replace(/\./g, "").replace(",", ".");
  const numero = Number.parseFloat(normalizado);
  if (!Number.isFinite(numero) || numero < 0) return 0;
  return Math.round(numero * 100);
}

/** Formatea una fecha ISO (YYYY-MM-DD o ISO completo) a formato legible. */
export function formatFecha(iso: string): string {
  const fecha = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(fecha.getTime())) return iso;
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(fecha);
}

/**
 * Formatea un CUIT / CUIL argentino como XX-XXXXXXXX-X. El valor guardado puede
 * llegar con o sin guiones y espacios (ej: "33714403309" -> "33-714403309-9").
 * Si no tiene exactamente 11 dígitos, se devuelve tal cual para no adulterar
 * datos no estándar.
 */
export function formatCuit(cuit: string): string {
  const digitos = cuit.replace(/\D/g, "");
  if (digitos.length !== 11) return cuit;
  return `${digitos.slice(0, 2)}-${digitos.slice(2, 10)}-${digitos.slice(10)}`;
}

/**
 * Zona horaria de los usuarios del sistema (Argentina). El "día de trabajo"
 * se calcula siempre con este reloj para que no dependa del horario del
 * servidor de hosting (suele estar en UTC y puede mostrar el día siguiente).
 */
export const ZONA_HORARIA = "America/Argentina/Buenos_Aires";

/** Devuelve la fecha de hoy en Buenos Aires como YYYY-MM-DD (uso en formularios y queries). */
export function fechaHoyLocal(): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_HORARIA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const obtener = (tipo: "year" | "month" | "day") =>
    partes.find((parte) => parte.type === tipo)?.value ?? "";
  return `${obtener("year")}-${obtener("month")}-${obtener("day")}`;
}

/**
 * Suma o resta días a una fecha YYYY-MM-DD y devuelve la fecha resultante.
 * Se construye con los componentes en hora local para no depender del reloj
 * del servidor (misma idea que `fechaHoyLocal`).
 */
export function sumarDias(fecha: string, cantidad: number): string {
  const [anio, mes, dia] = fecha.split("-").map(Number);
  const resultado = new Date(anio, mes - 1, dia + cantidad);
  const mesDos = String(resultado.getMonth() + 1).padStart(2, "0");
  const diaDos = String(resultado.getDate()).padStart(2, "0");
  return `${resultado.getFullYear()}-${mesDos}-${diaDos}`;
}

/** Devuelve true si el valor es una fecha YYYY-MM-DD real (no 2026-13-40). */
export function esFechaValida(
  valor: string | null | undefined,
): valor is string {
  if (!valor) return false;
  const partes = valor.split("-");
  if (partes.length !== 3) return false;
  const [anio, mes, dia] = partes.map(Number);
  if (
    !Number.isInteger(anio) ||
    !Number.isInteger(mes) ||
    !Number.isInteger(dia)
  ) {
    return false;
  }
  const fecha = new Date(anio, mes - 1, dia);
  return (
    fecha.getFullYear() === anio &&
    fecha.getMonth() === mes - 1 &&
    fecha.getDate() === dia
  );
}

/** Formatea una fecha YYYY-MM-DD en español largo, ej: "lunes, 15 de septiembre de 2026". */
export function fechaLegible(iso: string): string {
  if (!esFechaValida(iso)) return iso;
  const [anio, mes, dia] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(anio, mes - 1, dia, 12));
}

// ----------------------------------------------------------------------------
// Utilidades de meses (para listados por período, ej: gastos)
// ----------------------------------------------------------------------------

/** Devuelve el mes actual local en formato YYYY-MM. */
export function mesActualLocal(): string {
  return fechaHoyLocal().slice(0, 7);
}

/** Valida un mes YYYY-MM; devuelve el mes actual si el valor es inválido. */
export function normalizarMes(valor: string | null | undefined): string {
  return valor && /^\d{4}-\d{2}$/.test(valor) ? valor : mesActualLocal();
}

/** Suma o resta meses a un mes YYYY-MM y devuelve el mes resultado. */
export function sumarMeses(mes: string, cantidad: number): string {
  const [anio, numero] = mes.split("-").map(Number);
  const fecha = new Date(anio, numero - 1 + cantidad, 1);
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
}

/** Devuelve un mes YYYY-MM en formato legible es-AR, ej: "septiembre de 2026". */
export function mesLegible(mes: string): string {
  const [anio, numero] = mes.split("-").map(Number);
  return new Intl.DateTimeFormat("es-AR", {
    month: "long",
    year: "numeric",
  }).format(new Date(anio, numero - 1, 1, 12));
}