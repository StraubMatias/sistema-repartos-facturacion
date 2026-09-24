import { notFound } from "next/navigation";
import Link from "next/link";
import { obtenerRemitoCompleto } from "@/lib/data/remitos";
import { formatCuit, formatFecha, formatPesos } from "@/lib/types";
import { ButtonLink } from "@/app/components/ui/form";
import { Card, PageHeader } from "@/app/components/ui/display";
import { ConfirmDeleteButton } from "@/app/components/ui/ConfirmDeleteButton";
import { eliminarRemitoAction } from "@/app/actions/remitos";
import { ImprimirButton } from "@/app/components/remitos/ImprimirButton";

export const metadata = { title: "Remito" };

// Lee el remito completo por id en el server (fuera de cache/stream).
export const instant = false;

export default async function DetalleRemitoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const completo = await obtenerRemitoCompleto(Number(id));
  if (!completo) notFound();

  const { remito, reparto, cliente, clienteNombre, items } = completo;
  const totalCentavos = items.reduce(
    (total, item) => total + item.cantidad * item.precioUnitarioCentavos,
    0,
  );
  const numeroFormateado = String(remito.numero).padStart(4, "0");

  return (
    <div>
      {/* Barra de acciones (no se imprime) */}
      <div className="print:hidden">
        <PageHeader
          title={`Remito N° ${numeroFormateado}`}
          description="Vista previa y administración del remito."
          action={
            <ButtonLink href="/remitos" variant="ghost">
              ← Volver a remitos
            </ButtonLink>
          }
        />

        <div className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-4">
          <span className="text-sm text-zinc-500">
            Emitido el {formatFecha(remito.fecha)}
          </span>
          {reparto && (
            <div className="text-sm">
              <span className="text-zinc-500">
                Reparto del {formatFecha(reparto.fecha)}
              </span>{" "}
              <Link
                href={`/repartos/${reparto.id}`}
                className="font-medium text-emerald-700 underline-offset-2 hover:underline"
              >
                Abrir reparto
              </Link>
            </div>
          )}
          <ImprimirButton />
        </div>

        <Card className="mb-6 flex flex-wrap items-end gap-x-8 gap-y-4 p-4">
          <ConfirmDeleteButton
            action={eliminarRemitoAction}
            id={remito.id}
            confirmMessage="¿Eliminar este remito y sus líneas?"
            label="Eliminar remito"
          />
        </Card>
      </div>

      {/* Hoja imprimible */}
      <div
        id="hoja-remito"
        className="mx-auto max-w-3xl rounded-xl border border-zinc-200 bg-white p-8 shadow-sm print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none"
      >
        {/* Encabezado del comprobante */}
        <div className="flex items-start justify-between gap-6 border-b-2 border-zinc-900 pb-4">
          <div>
            <h1 className="text-xl font-black uppercase tracking-tight text-zinc-900">
              REMITO
            </h1>
            <p className="mt-1 text-sm text-zinc-600">N° {numeroFormateado}</p>
          </div>
          <div className="text-right text-sm">
            <p className="font-bold text-zinc-900">Distribuidora / Comercio</p>
            <p className="text-zinc-600">Fecha: {formatFecha(remito.fecha)}</p>
          </div>
        </div>

        {/* Datos del cliente (se resuelven a través del reparto del remito) */}
        <div className="grid gap-6 border-b border-zinc-200 py-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Cliente
            </p>
            <p className="mt-1 font-semibold text-zinc-900">
              {clienteNombre ?? (
                <span className="font-normal text-zinc-400">
                  Sin reparto asignado
                </span>
              )}
            </p>
            {cliente?.direccion && (
              <p className="text-sm text-zinc-600">{cliente.direccion}</p>
            )}
            {cliente?.localidad && (
              <p className="text-sm text-zinc-600">{cliente.localidad}</p>
            )}
          </div>
          <div>
            {cliente?.cuit && (
              <>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  CUIT / CUIL
                </p>
                <p className="mt-1 text-sm text-zinc-900">
                  {formatCuit(cliente.cuit)}
                </p>
              </>
            )}
            {cliente?.telefono && (
              <p className="mt-2 text-sm text-zinc-600">
                Tel: {cliente.telefono}
              </p>
            )}
          </div>
        </div>
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-300 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <th className="py-2 pr-4">Descripción</th>
              <th className="w-16 py-2 pr-4 text-center">Cant.</th>
              <th className="w-28 py-2 pr-4 text-right">P. unitario</th>
              <th className="w-28 py-2 text-right">Importe</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {items.map((item) => (
              <tr key={item.id}>
                <td className="py-2 pr-4 text-zinc-900">{item.descripcion}</td>
                <td className="py-2 pr-4 text-center text-zinc-700">
                  {item.cantidad}
                </td>
                <td className="py-2 pr-4 text-right text-zinc-700">
                  {formatPesos(item.precioUnitarioCentavos)}
                </td>
                <td className="py-2 text-right font-medium text-zinc-900">
                  {formatPesos(item.cantidad * item.precioUnitarioCentavos)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Total */}
        <div className="mt-4 flex justify-end">
          <div className="w-64 border-t-2 border-zinc-900 pt-2">
            <div className="flex items-center justify-between text-sm font-semibold text-zinc-900">
              <span>TOTAL</span>
              <span className="text-lg font-bold">
                {formatPesos(totalCentavos)}
              </span>
            </div>
          </div>
        </div>

        {/* Observaciones y firma */}
        {remito.observaciones && (
          <div className="mt-6 rounded-lg border border-zinc-200 p-3 text-sm text-zinc-600">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Observaciones
            </p>
            <p className="mt-1">{remito.observaciones}</p>
          </div>
        )}

        <div className="mt-16 grid grid-cols-2 gap-10">
          <div>
            <p className="border-t border-zinc-400 pt-2 text-center text-xs text-zinc-500">
              Recibí conforme · Firma y aclaración
            </p>
          </div>
          <div>
            <p className="border-t border-zinc-400 pt-2 text-center text-xs text-zinc-500">
              Empresa · Firma y aclaración
            </p>
          </div>
        </div>
      </div>

      <p className="mt-4 text-xs text-zinc-400 print:hidden">
        <Link href="/remitos" className="underline">
          Volver a remitos
        </Link>{" "}
        · Para imprimir usá el botón de arriba o Ctrl+P.
      </p>
    </div>
  );
}