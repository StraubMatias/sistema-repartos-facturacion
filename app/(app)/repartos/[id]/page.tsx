import { notFound } from "next/navigation";
import Link from "next/link";
import { obtenerReparto } from "@/lib/data/repartos";
import {
  listarRemitosDelReparto,
  listarRemitosSinAsignar,
} from "@/lib/data/remitos";
import { ETIQUETA_FORMA_PAGO, formatFecha, formatPesos } from "@/lib/types";
import { ButtonLink } from "@/app/components/ui/form";
import {
  Card,
  CardHeader,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/app/components/ui/display";
import { AsignarRemitosForm } from "@/app/components/repartos/AsignarRemitosForm";
import { ConfirmDeleteButton } from "@/app/components/ui/ConfirmDeleteButton";
import { eliminarRepartoAction } from "@/app/actions/repartos";

export const metadata = { title: "Reparto" };

// Lee el reparto por id + remitos en el server (fuera de cache/stream).
export const instant = false;

export default async function DetalleRepartoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const reparto = await obtenerReparto(Number(id));
  if (!reparto) notFound();

  const [remitos, disponibles] = await Promise.all([
    listarRemitosDelReparto(reparto.id),
    listarRemitosSinAsignar(),
  ]);

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={`Reparto del ${formatFecha(reparto.fecha)}`}
          description="Hoja de ruta con los remitos asignados."
          action={
            <ButtonLink
              href={`/repartos?fecha=${reparto.fecha}`}
              variant="ghost"
            >
              ← Volver a la hoja de ruta
            </ButtonLink>
          }
        />

        <Card className="mb-6 p-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Flete Origen
              </p>
              {reparto.clienteNombre === reparto.enviadoPor ? (
                <Link
                  href={`/clientes/${reparto.clienteId}`}
                  className="mt-1 inline-block text-sm text-emerald-700 underline-offset-2 hover:underline"
                >
                  {reparto.enviadoPor}
                </Link>
              ) : (
                <p className="mt-1 text-sm text-zinc-900">
                  {reparto.enviadoPor ?? (
                    <span className="text-zinc-400">—</span>
                  )}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Flete Destino
              </p>
              {reparto.clienteNombre === reparto.recibidoPor ? (
                <Link
                  href={`/clientes/${reparto.clienteId}`}
                  className="mt-1 inline-block text-sm text-emerald-700 underline-offset-2 hover:underline"
                >
                  {reparto.recibidoPor}
                </Link>
              ) : (
                <p className="mt-1 text-sm text-zinc-900">
                  {reparto.recibidoPor ?? (
                    <span className="text-zinc-400">—</span>
                  )}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Forma de pago
              </p>
              {reparto.formaPago ? (
                <p className="mt-1 text-sm font-medium text-emerald-700">
                  {ETIQUETA_FORMA_PAGO[reparto.formaPago]}
                </p>
              ) : (
                <p className="mt-1 text-sm font-medium text-red-600">
                  Por cobrar
                </p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Valor total
              </p>
              <p
                className={`mt-1 text-sm font-bold ${
                  reparto.formaPago != null ? "text-emerald-700" : "text-red-600"
                }`}
              >
                {formatPesos(reparto.valorCentavos)}
              </p>
            </div>
          </div>

          {reparto.observaciones && (
            <p className="mt-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
              {reparto.observaciones}
            </p>
          )}

          {reparto.items.length > 0 && (
            <div className="mt-4 rounded-lg border border-zinc-200 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Mercadería del reparto
              </p>
              <ul className="mt-1 divide-y divide-zinc-100">
                {reparto.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-baseline justify-between gap-4 py-2 text-sm"
                  >
                    <span className="font-medium text-zinc-900">
                      {item.cantidad} × {item.descripcion}
                    </span>
                    <span className="whitespace-nowrap text-zinc-700">
                      {formatPesos(item.cantidad * item.precioUnitarioCentavos)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4 border-t border-zinc-100 pt-4">
            <ConfirmDeleteButton
              action={eliminarRepartoAction}
              id={reparto.id}
              confirmMessage="¿Eliminar este reparto? Los remitos asignados quedarán sin reparto."
              label="Eliminar reparto"
            />
          </div>
        </Card>

        <Card className="mb-6">
          <CardHeader
            title={`Remitos del reparto (${remitos.length})`}
            description="Tocá un número para ver e imprimir el remito."
          />
          {remitos.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-zinc-500">
              Este reparto todavía no tiene remitos asignados.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>N°</Th>
                  <Th>Cliente</Th>
                  <Th className="text-right">Valor</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {remitos.map((remito) => (
                  <tr key={remito.id} className="hover:bg-zinc-50">
                    <Td>
                      <Link
                        href={`/remitos/${remito.id}`}
                        className="font-semibold text-emerald-700 underline-offset-2 hover:underline"
                      >
                        {String(remito.numero).padStart(4, "0")}
                      </Link>
                    </Td>
                    <Td>
                      {remito.clienteNombre ?? (
                        <span className="text-zinc-400">Sin reparto</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right font-medium text-zinc-900">
                      {formatPesos(remito.valorCentavos)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Asignar remitos"
            description="Seleccioná remitos sin asignar para sumarlos a esta hoja de ruta."
          />
          <div className="p-5">
            <AsignarRemitosForm
              repartoId={reparto.id}
              remitosDisponibles={disponibles}
            />
          </div>
        </Card>
      </div>

      <p className="mt-4 text-xs text-zinc-400">
        <Link href="/repartos" className="underline">
          Volver a la hoja de ruta
        </Link>
      </p>
    </div>
  );
}