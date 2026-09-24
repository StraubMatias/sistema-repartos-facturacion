import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import Link from "next/link";
import { obtenerCliente } from "@/lib/data/clientes";
import { listarRepartosDelCliente } from "@/lib/data/repartos";
import { formatCuit, formatFecha, formatPesos } from "@/lib/types";
import { ButtonLink } from "@/app/components/ui/form";
import {
  Badge,
  Card,
  CardHeader,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/app/components/ui/display";
import { ConfirmDeleteButton } from "@/app/components/ui/ConfirmDeleteButton";
import { eliminarClienteAction } from "@/app/actions/clientes";
import { FormaPagoSelect } from "@/app/components/repartos/FormaPagoSelect";
import { RemitoModal } from "@/app/components/repartos/RemitoModal";

export const metadata = { title: "Detalle de cliente" };

// Lee datos de la base por id fuera de Suspense/cache: no aplica la
// navegación "instantánea" de Cache Components. Bloquea el render como antes.
export const instant = false;

export default async function DetalleClientePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cliente = await obtenerCliente(Number(id));
  if (!cliente) notFound();

  // Repartos del cliente: la misma fila completa que el listado general; se
  // incluyen los repartos vinculados al cliente y los que lo tienen como Flete
  // Origen (envía) o Flete Destino (recibe) por nombre. Más el total que adeuda.
  const repartos = await listarRepartosDelCliente(cliente.id, cliente.nombre);
  const totalAdeudadoCentavos = repartos
    .filter((reparto) => !reparto.cobrado)
    .reduce((total, reparto) => total + reparto.valorCentavos, 0);

  const filas: Array<{ label: string; valor: ReactNode }> = [
    {
      label: "N° de cliente",
      valor: cliente.numero ?? <span className="text-zinc-400">Sin número</span>,
    },
    {
      label: "Tipo de cliente",
      valor: cliente.esCuentaCorriente ? (
        <Badge tone="sky">Cuenta corriente</Badge>
      ) : (
        <span className="text-zinc-400">—</span>
      ),
    },
    { label: "CUIT / CUIL", valor: cliente.cuit ? <Badge tone="sky">{formatCuit(cliente.cuit)}</Badge> : <span className="text-zinc-400">No cargado</span> },
    { label: "Domicilio", valor: [cliente.direccion, cliente.localidad].filter(Boolean).join(", ") || "—" },
    { label: "Teléfono", valor: cliente.telefono ?? "—" },
    { label: "Email", valor: cliente.email ?? "—" },
    {
      label: "Cliente desde",
      valor: formatFecha(cliente.creadoEn.slice(0, 10)),
    },
  ];

  return (
    <div>
      <PageHeader
        title={cliente.nombre}
        description={
          cliente.numero != null
            ? `Cliente N° ${cliente.numero}`
            : `Cliente #${cliente.id}`
        }
        action={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/clientes" variant="secondary">
              ← Clientes
            </ButtonLink>
            <ButtonLink
              href={`/clientes/${cliente.id}/editar`}
              variant="primary"
            >
              Editar
            </ButtonLink>
          </div>
        }
      />

      <Card className="mb-6">
        <CardHeader
          title="Datos del cliente"
          description="Numeración, contacto y datos fiscales en una sola línea."
        />
        <dl className="flex flex-wrap items-start gap-x-10 gap-y-3 px-5 py-5">
          {filas.map((fila) => (
            <div key={fila.label} className="min-w-32">
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                {fila.label}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-zinc-900">
                {fila.valor}
              </dd>
            </div>
          ))}
        </dl>
        {cliente.notas && (
          <div className="border-t border-zinc-100 px-5 py-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
              Notas
            </h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">
              {cliente.notas}
            </p>
          </div>
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader
          title={`Repartos del cliente (${repartos.length})`}
          description={
            repartos.length === 0
              ? "El cliente todavía no tiene repartos asociados."
              : `Total que adeuda: ${formatPesos(totalAdeudadoCentavos)}. Tocá la fecha para abrir cada reparto.`
          }
        />
        {repartos.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-zinc-500">
            Aún no hay repartos asociados a {cliente.nombre}.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Fecha</Th>
                <Th>Flete Destino</Th>
                <Th>Observaciones</Th>
                <Th>Remitos</Th>
                <Th className="text-right">Valor</Th>
                <Th>Forma de pago</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {repartos.map((reparto) => (
                <tr key={reparto.id} className="hover:bg-zinc-50">
                  <Td className="whitespace-nowrap">
                    <Link
                      href={`/repartos/${reparto.id}`}
                      className="font-semibold text-emerald-700 underline-offset-2 hover:underline"
                    >
                      {formatFecha(reparto.fecha)}
                    </Link>
                  </Td>
                  <Td>
                    {reparto.recibidoPor ?? (
                      <span className="text-zinc-400">—</span>
                    )}
                  </Td>
                  <Td className="max-w-56">
                    {reparto.observaciones ?? (
                      <span className="text-zinc-400">—</span>
                    )}
                  </Td>
                  <Td>
                    {reparto.remitos.length === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <RemitoModal remitos={reparto.remitos} />
                    )}
                  </Td>
                  <Td
                    className={`whitespace-nowrap text-right font-semibold ${
                      reparto.cobrado ? "text-emerald-700" : "text-red-600"
                    }`}
                  >
                    {formatPesos(reparto.valorCentavos)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <FormaPagoSelect
                      repartoId={reparto.id}
                      valorActual={reparto.formaPago}
                      enviadoPor={reparto.enviadoPor}
                      recibidoPor={reparto.recibidoPor}
                      clienteNombre={reparto.clienteNombre}
                      key={reparto.formaPago ?? "por-cobrar"}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="flex justify-end">
        <Card className="p-4">
          <ConfirmDeleteButton
            action={eliminarClienteAction}
            id={cliente.id}
            confirmMessage={`¿Eliminar a "${cliente.nombre}"? Esta acción es definitiva.`}
            label="Eliminar cliente"
          />
        </Card>
      </div>
    </div>
  );
}