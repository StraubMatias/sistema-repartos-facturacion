import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { listarGastosDelMesConTotal } from "@/lib/data/gastos";
import {
  CATEGORIAS_GASTO,
  ETIQUETA_CATEGORIA,
  formatFecha,
  formatPesos,
  mesActualLocal,
  mesLegible,
  normalizarMes,
  sumarMeses,
} from "@/lib/types";
import type { CategoriaGasto } from "@/lib/types";
import {
  Badge,
  Card,
  CardHeader,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/app/components/ui/display";
import { ButtonLink } from "@/app/components/ui/form";
import { GastoForm } from "@/app/components/gastos/GastoForm";
import { ConfirmDeleteButton } from "@/app/components/ui/ConfirmDeleteButton";
import { eliminarGastoAction } from "@/app/actions/gastos";

export const metadata = { title: "Gastos" };

const tonoCategoria: Record<CategoriaGasto, "amber" | "sky" | "emerald" | "zinc"> = {
  combustible: "amber",
  mecanico: "sky",
  insumos: "emerald",
  otros: "zinc",
};

/** Gastos del mes + total consolidado, cacheados ~1 min por mes consultado.
 *  La clave de caché incluye `mes` (searchParams), así cada período se cachea
 *  por separado. Invalida con revalidateTag al registrar/eliminar gastos. */
async function cargarGastos(mes: string) {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60 });
  cacheTag("gastos");
  return listarGastosDelMesConTotal(mes);
}

export default function GastosPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  return (
    <Suspense fallback={<SkeletonGastos />}>
      <ContenidoGastos searchParams={searchParams} />
    </Suspense>
  );
}

/** Render del mes completo. Lee `searchParams` acá (aislado en <Suspense>)
 *  para que el shell de /gastos se pueda prerenderizar con Cache Components;
 *  la data viene del cache de ~1 min (cargarGastos). */
async function ContenidoGastos({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const { mes } = await searchParams;
  const mesSeleccionado = normalizarMes(mes);
  const esMesActual = mesSeleccionado === mesActualLocal();
  const mesAnterior = sumarMeses(mesSeleccionado, -1);
  const mesSiguiente = sumarMeses(mesSeleccionado, 1);

  const { gastos, totalCentavos: total } = await cargarGastos(mesSeleccionado);

  const porCategoria = CATEGORIAS_GASTO.map((categoria) => ({
    categoria,
    total: gastos
      .filter((g) => g.categoria === categoria)
      .reduce((acc, g) => acc + g.montoCentavos, 0),
  })).filter((fila) => fila.total > 0);

  return (
    <div>
      <PageHeader
        title="Gastos operativos"
        description="Registrá gastos y consultalos mes a mes con las flechas del selector de período."
      />

      {/* Selector de mes */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 shadow-sm">
          <ButtonLink
            href={`/gastos?mes=${mesAnterior}`}
            variant="secondary"
            className="px-3"
            aria-label="Mes anterior"
            title="Mes anterior"
          >
            ←
          </ButtonLink>
          <div className="w-52 text-center">
            <p className="text-base font-bold capitalize leading-tight text-zinc-900">
              {mesLegible(mesSeleccionado)}
            </p>
            <p className="text-xs text-zinc-500">
              {gastos.length} movimiento{gastos.length === 1 ? "" : "s"} ·{" "}
              {formatPesos(total)}
            </p>
          </div>
          <ButtonLink
            href={`/gastos?mes=${mesSiguiente}`}
            variant="secondary"
            className="px-3"
            disabled={esMesActual}
            aria-label="Mes siguiente"
            title={esMesActual ? "Estás viendo el mes actual" : "Mes siguiente"}
          >
            →
          </ButtonLink>
        </div>

        {!esMesActual && (
          <ButtonLink href="/gastos" variant="ghost">
            ← Volver al mes actual
          </ButtonLink>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CATEGORIAS_GASTO.map((categoria) => {
              const fila = porCategoria.find(
                (f) => f.categoria === categoria,
              );
              return (
                <Card key={categoria} className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                      {ETIQUETA_CATEGORIA[categoria]}
                    </p>
                    <Badge tone={tonoCategoria[categoria]}>
                      {gastos.filter((g) => g.categoria === categoria).length}
                    </Badge>
                  </div>
                  <p className="mt-2 text-lg font-semibold text-zinc-900">
                    {formatPesos(fila?.total ?? 0)}
                  </p>
                </Card>
              );
            })}
          </div>

          <Card>
            <CardHeader
              title="Movimientos"
              description={`Gastos de ${mesLegible(mesSeleccionado)}, los más recientes primero.`}
            />
            {gastos.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-zinc-500">
                No hay gastos registrados en {mesLegible(mesSeleccionado)}.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Fecha</Th>
                    <Th>Categoría</Th>
                    <Th>Descripción</Th>
                    <Th>Proveedor</Th>
                    <Th className="text-right">Monto</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {gastos.map((gasto) => (
                    <tr key={gasto.id} className="hover:bg-zinc-50">
                      <Td className="whitespace-nowrap">
                        {formatFecha(gasto.fecha)}
                      </Td>
                      <Td>
                        <Badge tone={tonoCategoria[gasto.categoria]}>
                          {ETIQUETA_CATEGORIA[gasto.categoria]}
                        </Badge>
                      </Td>
                      <Td>{gasto.descripcion}</Td>
                      <Td>{gasto.proveedor ?? <span className="text-zinc-400">—</span>}</Td>
                      <Td className="whitespace-nowrap text-right font-semibold text-zinc-900">
                        {formatPesos(gasto.montoCentavos)}
                      </Td>
                      <Td className="text-right">
                        <ConfirmDeleteButton
                          action={eliminarGastoAction}
                          id={gasto.id}
                          confirmMessage={`¿Eliminar el gasto "${gasto.descripcion}"?`}
                          label="Eliminar"
                          pendingLabel="…"
                          variant="ghost"
                          formClassName=""
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader
              title="Nuevo gasto"
              description="Combustible, mecánico, insumos y otros."
            />
            <div className="p-5">
              <GastoForm />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Esqueleto del contenido de /gastos mientras streama el mes (y mientras el
 *  router navega). Evita que el área de contenido quede en blanco. */
function SkeletonGastos() {
  return (
    <div className="animate-pulse">
      <div className="mb-6 h-14 w-full rounded-xl bg-zinc-200" />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-zinc-200" />
        ))}
      </div>
      <div className="h-72 rounded-xl bg-zinc-200" />
    </div>
  );
}