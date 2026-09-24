"use server";

import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import type { EstadoAction } from "@/app/actions/estado";
import { exigirAdmin } from "@/lib/auth";
import {
  crearGasto,
  eliminarGasto as eliminarGastoDb,
} from "@/lib/data/gastos";
import { pesosACentavos } from "@/lib/types";
import type { CategoriaGasto } from "@/lib/types";

const CATEGORIAS_VALIDAS: CategoriaGasto[] = [
  "combustible",
  "mecanico",
  "insumos",
  "otros",
];

function texto(formData: FormData, campo: string): string {
  return String(formData.get(campo) ?? "").trim();
}

function textoOpcional(formData: FormData, campo: string): string | undefined {
  const valor = texto(formData, campo);
  return valor.length > 0 ? valor : undefined;
}

// ----------------------------------------------------------------------------
// Registro de gasto
// ----------------------------------------------------------------------------
export async function crearGastoAction(
  _estado: EstadoAction,
  formData: FormData,
): Promise<EstadoAction> {
  await exigirAdmin();
  const fecha = texto(formData, "fecha");
  const categoria = texto(formData, "categoria") as CategoriaGasto;
  const descripcion = texto(formData, "descripcion");
  const monto = pesosACentavos(texto(formData, "monto"));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return { error: "La fecha es obligatoria." };
  }
  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return { error: "Elegí una categoría válida." };
  }
  if (!descripcion) {
    return { error: "La descripción es obligatoria." };
  }
  if (monto <= 0) {
    return { error: "El monto debe ser mayor a cero." };
  }

  try {
    await crearGasto({
      fecha,
      categoria,
      descripcion,
      proveedor: textoOpcional(formData, "proveedor"),
      montoCentavos: monto,
    });
  } catch {
    // No exponer detalles del error al usuario
    console.error("[gastos] error al registrar");
    return {
      error: "No se pudo registrar el gasto. Intentá de nuevo.",
    };
  }

  revalidatePath("/gastos");
  revalidatePath("/");
  updateTag("gastos");
  redirect("/gastos");
}

// ----------------------------------------------------------------------------
// Eliminación de gasto
// ----------------------------------------------------------------------------
export async function eliminarGastoAction(
  _estado: EstadoAction,
  formData: FormData,
): Promise<EstadoAction> {
  await exigirAdmin();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return { error: "Gasto inválido." };
  }

  try {
    await eliminarGastoDb(id);
  } catch {
    // No exponer detalles del error al usuario
    console.error("[gastos] error al eliminar");
    return { error: "No se pudo eliminar el gasto. Intentá de nuevo." };
  }

  revalidatePath("/gastos");
  revalidatePath("/");
  updateTag("gastos");
  return { error: null };
}