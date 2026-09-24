import { notFound } from "next/navigation";
import { obtenerVehiculo } from "@/lib/data/vehiculos";
import { ButtonLink } from "@/app/components/ui/form";
import { Card, PageHeader } from "@/app/components/ui/display";
import { VehiculoEditForm } from "@/app/components/vehiculos/VehiculoEditForm";
import { ConfirmDeleteButton } from "@/app/components/ui/ConfirmDeleteButton";
import { eliminarVehiculoAction } from "@/app/actions/vehiculos";

export const metadata = { title: "Editar vehículo" };

// Lee el vehículo por id en el server (fuera de cache/stream).
export const instant = false;

export default async function EditarVehiculoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const vehiculo = await obtenerVehiculo(Number(id));
  if (!vehiculo) notFound();

  return (
    <div>
      <PageHeader
        title={`Editar: ${vehiculo.nombre}`}
        description="Actualizá los datos del vehículo. Los cambios se guardan al enviar."
        action={
          <ButtonLink href={`/vehiculos/${vehiculo.id}`} variant="secondary">
            ← Volver al detalle
          </ButtonLink>
        }
      />
      <Card className="max-w-2xl p-5">
        <VehiculoEditForm vehiculo={vehiculo} />
      </Card>

      <Card className="mt-6 max-w-2xl border-red-200 p-5">
        <h2 className="text-sm font-semibold text-red-700">Zona de peligro</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Eliminar al vehículo es definitivo. Se vuelve al listado después de
          borrarlo.
        </p>
        <div className="mt-3">
          <ConfirmDeleteButton
            action={eliminarVehiculoAction}
            id={vehiculo.id}
            confirmMessage={`¿Eliminar el vehículo "${vehiculo.nombre}"? Esta acción es definitiva.`}
            label="Eliminar vehículo"
          />
        </div>
      </Card>
    </div>
  );
}