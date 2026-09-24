import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { obtenerVehiculo } from "@/lib/data/vehiculos";
import { formatFecha, formatKilometros } from "@/lib/types";
import { ButtonLink } from "@/app/components/ui/form";
import {
  Badge,
  Card,
  CardHeader,
  PageHeader,
} from "@/app/components/ui/display";
import { ConfirmDeleteButton } from "@/app/components/ui/ConfirmDeleteButton";
import { eliminarVehiculoAction } from "@/app/actions/vehiculos";

export const metadata = { title: "Detalle de vehículo" };

// Lee el vehículo por id en el server (fuera de cache/stream).
export const instant = false;

export default async function DetalleVehiculoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const vehiculo = await obtenerVehiculo(Number(id));
  if (!vehiculo) notFound();

  const filas: Array<{ label: string; valor: ReactNode }> = [
    { label: "Patente / dominio", valor: vehiculo.patente ?? <span className="text-zinc-400">No cargada</span> },
    {
      label: "Marca / Modelo",
      valor: [vehiculo.marca, vehiculo.modelo].filter(Boolean).join(" ") || "—",
    },
    { label: "Año", valor: vehiculo.anio ?? "—" },
    {
      label: "Kilómetros actuales",
      valor: vehiculo.kilometros != null ? (
        <span className="font-semibold tabular-nums">{formatKilometros(vehiculo.kilometros)}</span>
      ) : (
        "—"
      ),
    },
    { label: "Último service", valor: vehiculo.fechaUltimoService ? formatFecha(vehiculo.fechaUltimoService) : <Badge tone="amber">Sin registrar</Badge> },
    {
      label: "Próximo service",
      valor: vehiculo.kmProximoService != null ? (
        formatKilometros(vehiculo.kmProximoService)
      ) : (
        "—"
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={vehiculo.nombre}
        description={vehiculo.patente ? `Patente ${vehiculo.patente}` : "Vehículo de la flota"}
        action={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/vehiculos" variant="secondary">
              ← Vehículos
            </ButtonLink>
            <ButtonLink
              href={`/vehiculos/${vehiculo.id}/editar`}
              variant="primary"
            >
              Editar
            </ButtonLink>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Datos del vehículo" />
          <dl className="grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2">
            {filas.map((fila) => (
              <div key={fila.label}>
                <dt className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                  {fila.label}
                </dt>
                <dd className="mt-0.5 text-sm text-zinc-800">{fila.valor}</dd>
              </div>
            ))}
          </dl>
          {vehiculo.notas && (
            <div className="border-t border-zinc-100 px-5 py-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Notas
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">
                {vehiculo.notas}
              </p>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Control de service"
            description="Kilómetros y vencimientos"
          />
          <p className="px-5 py-8 text-sm text-zinc-500">
            Acá vas a poder registrar el historial de services del{" "}
            <span className="font-medium text-zinc-700">{vehiculo.nombre}</span>{" "}
            y ver alertas cuando se acerque el próximo service.
          </p>
        </Card>
      </div>

      <div className="mt-6 flex justify-end">
        <Card className="p-4">
          <ConfirmDeleteButton
            action={eliminarVehiculoAction}
            id={vehiculo.id}
            confirmMessage={`¿Eliminar el vehículo "${vehiculo.nombre}"? Esta acción es definitiva.`}
            label="Eliminar vehículo"
          />
        </Card>
      </div>
    </div>
  );
}