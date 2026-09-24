import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { migrate } from "@/lib/migrate";
import { getMetricasDashboard } from "@/lib/data/dashboard";
import { fechaHoyLocal } from "@/lib/types";
import {
  actualizarCliente,
  crearCliente,
  crearClientesEnLote,
  eliminarCliente,
  listarClientes,
  listarClientesParaSeleccion,
  listarClientesResumen,
  obtenerCliente,
  obtenerOCrearClientePorNombre,
} from "@/lib/data/clientes";
import {
  crearGasto,
  listarGastosDelMesConTotal,
} from "@/lib/data/gastos";
import {
  actualizarFormaPagoReparto,
  asignarRemitosAReparto,
  crearReparto,
  obtenerHojaDeRutaDia,
  listarRepartos,
  listarRepartosDelCliente,
  obtenerPartesReparto,
  obtenerReparto,
} from "@/lib/data/repartos";
import {
  crearRemito,
  listarRemitosDelReparto,
  obtenerRemito,
  obtenerRemitoCompleto,
  proximoNumeroRemito,
} from "@/lib/data/remitos";

/**
 * Tests de integración de la capa de datos sobre la SQLite temporal
 * (`LOCAL_DB_FILE=:memory:`, configurado en vitest.config.ts).
 * Cada test arranca con las tablas vacías para ser determinista.
 */

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  const db = await getDb();
  // Orden inverso de dependencias de FK.
  await db.execute("DELETE FROM remito_items");
  await db.execute("DELETE FROM remitos");
  await db.execute("DELETE FROM reparto_items");
  await db.execute("DELETE FROM repartos");
  await db.execute("DELETE FROM gastos");
  await db.execute("DELETE FROM vehiculos");
  await db.execute("DELETE FROM clientes");
});

async function crearClienteBasico(numero: number): Promise<number> {
  return crearCliente({ nombre: `Cliente ${numero}` });
}

describe("flujo clientes", () => {
  it("crea, consulta, actualiza, lista y elimina", async () => {
    const id = await crearClienteBasico(1);

    const creado = await obtenerCliente(id);
    expect(creado?.nombre).toBe("Cliente 1");
    // El N° del cliente es su id (se asigna solo en el alta, no se edita).
    expect(creado?.numero).toBe(id);

    await actualizarCliente(id, { nombre: "Cliente Uno SRL" });
    expect((await obtenerCliente(id))?.nombre).toBe("Cliente Uno SRL");

    const lista = await listarClientes();
    expect(lista).toHaveLength(1);

    await eliminarCliente(id);
    expect(await obtenerCliente(id)).toBeNull();
  });

  it("elimina un cliente aunque tenga remitos (el remito depende del reparto)", async () => {
    const clienteId = await crearClienteBasico(2);
    const repartoId = await crearReparto({
      fecha: "2026-09-13",
      clienteId,
      enviadoPor: "Cliente 2",
    });
    await crearRemito({
      numero: await proximoNumeroRemito(),
      repartoId,
      fecha: "2026-09-13",
      items: [{ descripcion: "a", cantidad: 1, precioUnitarioCentavos: 100 }],
    });

    // El remito no referencia al cliente (solo al reparto): la baja no se
    // bloquea. El reparto queda con cliente null (ON DELETE SET NULL) pero
    // conserva su remito.
    await eliminarCliente(clienteId);

    const reparto = await obtenerReparto(repartoId);
    expect(reparto?.clienteId).toBeNull();
    expect(reparto?.enviadoPor).toBe("Cliente 2");
    expect(await listarRemitosDelReparto(repartoId)).toHaveLength(1);
  });

  it("inserta clientes en lote y las vistas livianas no exponen notas", async () => {
    const resultado = await crearClientesEnLote([
      { nombre: "Cliente Diez", notas: "Nota interna secreta" },
      { nombre: "Cliente Once" },
    ]);
    expect(resultado.importados).toBe(2);
    expect(resultado.errores).toBe(0);

    // La vista resumen (tabla) no incluye notas ni fechas.
    const resumen = await listarClientesResumen();
    expect(resumen).toHaveLength(2);
    expect(resumen[0]).not.toHaveProperty("notas");
    expect(resumen[0]).not.toHaveProperty("creadoEn");

    // La vista de selección solo trae id y nombre.
    const seleccion = await listarClientesParaSeleccion();
    expect(seleccion).toHaveLength(2);
    expect(Object.keys(seleccion[0]).sort()).toEqual(["id", "nombre"]);

    // El detalle sí conserva las notas.
    const detalle = await obtenerCliente(resumen[0].id);
    expect(detalle?.notas).toBe("Nota interna secreta");

    // El N° de cada cliente importado es su id (automático, no editable).
    for (const cliente of resumen) {
      expect((await obtenerCliente(cliente.id))?.numero).toBe(cliente.id);
      expect((await obtenerCliente(cliente.id))?.esCuentaCorriente).toBe(true);
    }
  });

  it("obtiene o crea un cliente por nombre sin duplicar (envía del reparto)", async () => {
    const idCreado = await obtenerOCrearClientePorNombre("Peluquería Nuevo Sur");
    const cliente = await obtenerCliente(idCreado);
    expect(cliente?.nombre).toBe("Peluquería Nuevo Sur");
    // Se crea solo con el nombre (el resto de los campos queda vacío) y en
    // cuenta corriente. El N° es el id.
    expect(cliente?.numero).toBe(idCreado);
    expect(cliente?.cuit).toBeNull();
    expect(cliente?.esCuentaCorriente).toBe(true);

    // El mismo nombre (sin distinguir mayúsculas) reutiliza el cliente.
    const idExistente = await obtenerOCrearClientePorNombre("peluquería nuevo sur");
    expect(idExistente).toBe(idCreado);
    expect(await listarClientes()).toHaveLength(1);
  });

  it("no duplica el cliente del reparto si el nombre varía en tildes o espacios", async () => {
    const id = await crearCliente({ nombre: "José  López" });

    // "Jose Lopez" (sin tilde, espacios juntos) reutiliza al existente.
    const reutilizado = await obtenerOCrearClientePorNombre("  jose lopez ");
    expect(reutilizado).toBe(id);

    // Un nombre realmente distinto sí crea uno nuevo.
    const otro = await obtenerOCrearClientePorNombre("María Del Mar");
    expect(otro).not.toBe(id);
    expect(await listarClientes()).toHaveLength(2);
  });
});

describe("flujo remitos", () => {
  it("crea un remito con items dentro de un reparto y calcula su valor total", async () => {
    const clienteId = await crearClienteBasico(3);
    const repartoId = await crearReparto({ fecha: "2026-09-13", clienteId });
    const numero = await proximoNumeroRemito();

    const remitoId = await crearRemito({
      numero,
      repartoId,
      fecha: "2026-09-13",
      observaciones: "Entregar antes de las 12",
      items: [
        { descripcion: "Caja de agua", cantidad: 2, precioUnitarioCentavos: 12000 },
        { descripcion: "Gaseosa x12", cantidad: 1, precioUnitarioCentavos: 2500 },
      ],
    });

    const completo = await obtenerRemitoCompleto(remitoId);
    expect(completo).not.toBeNull();
    expect(completo!.items).toHaveLength(2);
    // El cliente sale del reparto, no del remito.
    expect(completo!.cliente?.nombre).toBe("Cliente 3");
    expect(completo!.reparto?.id).toBe(repartoId);
    expect(completo!.clienteNombre).toBe("Cliente 3");
    // 2 * 12000 + 1 * 2500 = 26500 (antes el detalle daba $0)
    expect(completo!.remito.valorCentavos).toBe(26500);
    await expect(obtenerRemito(remitoId)).resolves.toMatchObject({
      valorCentavos: 26500,
    });
  });

  it("autoasigna números correlativos", async () => {
    const clienteId = await crearClienteBasico(4);
    const repartoId = await crearReparto({ fecha: "2026-09-13", clienteId });
    const primero = await proximoNumeroRemito();
    const id1 = await crearRemito({
      numero: primero,
      repartoId,
      fecha: "2026-09-13",
      items: [{ descripcion: "x", cantidad: 1, precioUnitarioCentavos: 10 }],
    });
    const id2 = await crearRemito({
      numero: await proximoNumeroRemito(),
      repartoId,
      fecha: "2026-09-13",
      items: [{ descripcion: "y", cantidad: 1, precioUnitarioCentavos: 20 }],
    });

    const r1 = await obtenerRemito(id1);
    const r2 = await obtenerRemito(id2);
    expect(r2!.numero).toBe(r1!.numero + 1);
  });
});

describe("flujo repartos y asignación de remitos", () => {
  it("calcula el valor total del reparto sumando los items (regresión $0)", async () => {
    const clienteId = await crearClienteBasico(5);
    const repartoId = await crearReparto({
      fecha: "2026-09-13",
      clienteId,
      enviadoPor: "Jorge",
      recibidoPor: "F-100",
    });

    await crearRemito({
      numero: await proximoNumeroRemito(),
      repartoId,
      fecha: "2026-09-13",
      items: [{ descripcion: "a", cantidad: 3, precioUnitarioCentavos: 1000 }],
    });
    await crearRemito({
      numero: await proximoNumeroRemito(),
      repartoId,
      fecha: "2026-09-13",
      items: [{ descripcion: "b", cantidad: 1, precioUnitarioCentavos: 5000 }],
    });

    const reparto = await obtenerReparto(repartoId);
    // 3 * 1000 + 1 * 5000 = 8000. Antes este campo daba 0 siempre.
    expect(reparto?.valorCentavos).toBe(8000);
    expect(reparto?.enviadoPor).toBe("Jorge");

    const remitos = await listarRemitosDelReparto(repartoId);
    expect(remitos).toHaveLength(2);

    const lista = await listarRepartos();
    expect(lista).toHaveLength(1);
    expect(lista[0].valorCentavos).toBe(8000);
  });

  it("vincula el cliente del Envía al reparto al cobrar en cuenta corriente", async () => {
    const clienteId = await crearCliente({ nombre: "Almacén Don José" });
    const repartoId = await crearReparto({
      fecha: "2026-09-13",
      enviadoPor: "Almacén Don José",
    });

    // La Server Action resuelve/crea el cliente y lo pasa acá.
    await actualizarFormaPagoReparto(repartoId, "cuenta_corriente", clienteId);

    const reparto = await obtenerReparto(repartoId);
    expect(reparto?.clienteId).toBe(clienteId);
    expect(reparto?.formaPago).toBe("cuenta_corriente");
    expect(reparto?.cobrado).toBe(true);

    // Cambiar a otra forma NO desvincula al cliente.
    await actualizarFormaPagoReparto(repartoId, "debito");
    expect((await obtenerReparto(repartoId))?.clienteId).toBe(clienteId);
  });

  it("no reasigna un remito que ya tiene reparto", async () => {
    const clienteId = await crearClienteBasico(6);
    const reparto1 = await crearReparto({ fecha: "2026-09-13", clienteId });
    const remitoId = await crearRemito({
      numero: await proximoNumeroRemito(),
      repartoId: reparto1,
      fecha: "2026-09-13",
      items: [{ descripcion: "a", cantidad: 1, precioUnitarioCentavos: 10 }],
    });

    const reparto2 = await crearReparto({ fecha: "2026-09-13" });
    await asignarRemitosAReparto(reparto2, [remitoId]);

    expect(await listarRemitosDelReparto(reparto1)).toHaveLength(1);
    expect(await listarRemitosDelReparto(reparto2)).toHaveLength(0);
  });

  it("crea un reparto con cliente y mercadería directa (varias líneas) y calcula su valor", async () => {
    const clienteId = await crearClienteBasico(7);
    const repartoId = await crearReparto({
      fecha: "2026-09-13",
      clienteId,
      enviadoPor: "Cliente 7",
      llevaRemito: false,
      itemsMercaderia: [
        {
          descripcion: "Caja de agua",
          cantidad: 3,
          precioUnitarioCentavos: 2500,
        },
        {
          descripcion: "Rueda 175/70",
          cantidad: 2,
          precioUnitarioCentavos: 15000,
        },
      ],
      formaPago: "cuenta_corriente",
    });

    const reparto = await obtenerReparto(repartoId);
    expect(reparto?.clienteId).toBe(clienteId);
    expect(reparto?.clienteNombre).toBe("Cliente 7");
    expect(reparto?.llevaRemito).toBe(false);
    expect(reparto?.items).toHaveLength(2);
    expect(reparto?.items[0]).toMatchObject({
      descripcion: "Caja de agua",
      cantidad: 3,
      precioUnitarioCentavos: 2500,
    });
    expect(reparto?.formaPago).toBe("cuenta_corriente");
    expect(reparto?.cobrado).toBe(true);
    // 3 × $2.500 + 2 × $15.000 = $37.500 (la mercadería directa suma al valor)
    expect(reparto?.valorCentavos).toBe(37500);
  });

  it("lista los repartos de un cliente para su ficha (con items y total)", async () => {
    const clienteA = await crearClienteBasico(9);
    const clienteB = await crearClienteBasico(10);

    const r1 = await crearReparto({
      fecha: "2026-09-15",
      clienteId: clienteA,
      itemsMercaderia: [
        { descripcion: "Caja", cantidad: 1, precioUnitarioCentavos: 1000 },
      ],
    });
    await crearReparto({ fecha: "2026-09-16", clienteId: clienteB });

    const repartosA = await listarRepartosDelCliente(clienteA, "Cliente 9");
    expect(repartosA).toHaveLength(1);
    expect(repartosA[0].id).toBe(r1);
    expect(repartosA[0].items).toHaveLength(1);
    expect(repartosA[0].items[0].descripcion).toBe("Caja");
    expect(repartosA[0].valorCentavos).toBe(1000);
    expect(repartosA[0].formaPago).toBeNull();
  });

  it("incluye en la ficha los repartos donde el cliente aparece como Flete Origen o Destino por nombre", async () => {
    const clienteA = await crearClienteBasico(9); // "Cliente 9"
    const clienteB = await crearClienteBasico(10);

    // El cliente A está vinculado como cliente del reparto: r1 siempre aparece.
    const r1 = await crearReparto({
      fecha: "2026-09-15",
      clienteId: clienteA,
    });
    // El cliente A aparece SOLO como Flete Destino (quién recibe) en un reparto
    // vinculado a otro cliente: igual debe aparecer en la ficha de A.
    const comoDestino = await crearReparto({
      fecha: "2026-09-16",
      clienteId: clienteB,
      enviadoPor: "Cliente 10",
      recibidoPor: "Cliente 9",
      itemsMercaderia: [
        { descripcion: "Caja", cantidad: 1, precioUnitarioCentavos: 700 },
      ],
    });
    // El cliente A aparece como Flete Origen (quién envía) sin estar vinculado,
    // y con el nombre en distinta capitalización: también debe aparecer.
    const comoOrigen = await crearReparto({
      fecha: "2026-09-17",
      enviadoPor: "cliente 9",
      itemsMercaderia: [
        { descripcion: "Bulto", cantidad: 2, precioUnitarioCentavos: 500 },
      ],
    });

    const repartos = await listarRepartosDelCliente(clienteA, "Cliente 9");
    expect(repartos.map((r) => r.id).sort()).toEqual(
      [r1, comoDestino, comoOrigen].sort(),
    );
    expect(repartos.find((r) => r.id === comoDestino)?.valorCentavos).toBe(700);
    expect(repartos.find((r) => r.id === comoOrigen)?.valorCentavos).toBe(1000);
  });

  it("ordena los repartos por fecha, los más recientes primero", async () => {
    const clienteId = await crearClienteBasico(14);

    // Repartos de distintas fechas: 10/09, 11/09 y 13/09.
    const masViejo = await crearReparto({
      fecha: "2026-09-10",
      clienteId,
      itemsMercaderia: [
        { descripcion: "a", cantidad: 1, precioUnitarioCentavos: 100 },
      ],
    });
    const delMedio = await crearReparto({
      fecha: "2026-09-11",
      clienteId,
      itemsMercaderia: [
        { descripcion: "b", cantidad: 1, precioUnitarioCentavos: 100 },
      ],
    });
    const masNuevo = await crearReparto({
      fecha: "2026-09-13",
      clienteId,
      itemsMercaderia: [
        { descripcion: "c", cantidad: 1, precioUnitarioCentavos: 100 },
      ],
    });

    // La fecha más reciente queda primero en la hoja de ruta.
    const masReciente = await crearReparto({ fecha: "2026-09-15", clienteId });

    const lista = await listarRepartos();
    expect(lista.map((r) => r.id)).toEqual([
      masReciente,
      masNuevo,
      delMedio,
      masViejo,
    ]);
  });

  it("crea un remito ya asignado a un reparto y lo lista en listarRepartos().remitos", async () => {
    const clienteId = await crearClienteBasico(8);
    const repartoId = await crearReparto({ fecha: "2026-09-14", clienteId });
    const remitoId = await crearRemito({
      numero: await proximoNumeroRemito(),
      repartoId,
      fecha: "2026-09-14",
      items: [{ descripcion: "a", cantidad: 1, precioUnitarioCentavos: 100 }],
    });

    const lista = await listarRepartos();
    const reparto = lista.find((r) => r.id === repartoId);
    expect(reparto?.remitos).toHaveLength(1);
    expect(reparto?.remitos[0].id).toBe(remitoId);
    expect(reparto?.remitos[0].numero).toBeGreaterThan(0);
    expect(reparto?.valorCentavos).toBe(100);
  });

  it("actualiza la forma de pago de un reparto (por cobrar hasta que se elige)", async () => {
    const repartoId = await crearReparto({ fecha: "2026-09-14" });
    const sinCobrar = await obtenerReparto(repartoId);
    expect(sinCobrar?.formaPago).toBeNull();
    expect(sinCobrar?.cobrado).toBe(false);

    await actualizarFormaPagoReparto(repartoId, "cheque");
    const cobrado = await obtenerReparto(repartoId);
    expect(cobrado?.formaPago).toBe("cheque");
    expect(cobrado?.cobrado).toBe(true);

    // La opción "Por cobrar" (null) vuelve a dejar el reparto sin cobrar.
    await actualizarFormaPagoReparto(repartoId, null);
    const porCobrar = await obtenerReparto(repartoId);
    expect(porCobrar?.formaPago).toBeNull();
    expect(porCobrar?.cobrado).toBe(false);
  });

  it("calcula la deuda por cliente (repartos sin cobrar)", async () => {
    const clienteA = await crearClienteBasico(11);
    const clienteB = await crearClienteBasico(12);

    // A debe: 2 repartos sin cobrar (500 + 300 = 800).
    await crearReparto({
      fecha: "2026-09-14",
      clienteId: clienteA,
      itemsMercaderia: [
        { descripcion: "Caja", cantidad: 1, precioUnitarioCentavos: 500 },
      ],
    });
    await crearReparto({
      fecha: "2026-09-15",
      clienteId: clienteA,
      itemsMercaderia: [
        { descripcion: "Bolsa", cantidad: 1, precioUnitarioCentavos: 300 },
      ],
    });

    // A tiene un reparto cobrado que no suma a la deuda.
    await crearReparto({
      fecha: "2026-09-16",
      clienteId: clienteA,
      itemsMercaderia: [
        { descripcion: "Caja", cantidad: 1, precioUnitarioCentavos: 900 },
      ],
      formaPago: "contado",
    });

    // B debe $100 (sin cobrar).
    await crearReparto({
      fecha: "2026-09-14",
      clienteId: clienteB,
      itemsMercaderia: [
        { descripcion: "Sobre", cantidad: 1, precioUnitarioCentavos: 100 },
      ],
    });
    // Cliente sin repartos no figura con deuda.
    const clienteSinRepartos = await crearClienteBasico(13);

    const resumen = await listarClientesResumen();
    const deudaA = resumen.find((c) => c.id === clienteA)?.deudaCentavos;
    const deudaB = resumen.find((c) => c.id === clienteB)?.deudaCentavos;
    const deudaSinRepartos = resumen.find((c) => c.id === clienteSinRepartos)?.deudaCentavos;
    expect(deudaA).toBe(800);
    expect(deudaB).toBe(100);
    expect(deudaSinRepartos).toBe(0);
  });

  it("lista los días del mes que tienen repartos (calendario de la Hoja de Ruta)", async () => {
    await crearReparto({ fecha: "2026-09-13", enviadoPor: "A" });
    await crearReparto({ fecha: "2026-09-13", enviadoPor: "B" });
    await crearReparto({ fecha: "2026-09-15", enviadoPor: "C" });
    // Fuera del mes: no debe aparecer.
    await crearReparto({ fecha: "2026-08-31", enviadoPor: "D" });

    const hoja1 = await obtenerHojaDeRutaDia("2026-09-13");
    expect(hoja1.diasConRepartos).toEqual(["2026-09-13", "2026-09-15"]);
    
    const hoja2 = await obtenerHojaDeRutaDia("2026-07-15");
    expect(hoja2.diasConRepartos).toEqual([]);
  });

  it("devuelve el Flete Origen, el Flete Destino y el cliente del reparto", async () => {
    const clienteId = await crearClienteBasico(14);
    const repartoId = await crearReparto({
      fecha: "2026-09-13",
      clienteId,
      enviadoPor: "Expreso Norte",
      recibidoPor: "Distribuidora Sur",
    });

    const partes = await obtenerPartesReparto(repartoId);
    expect(partes).toEqual({
      clienteId,
      enviadoPor: "Expreso Norte",
      recibidoPor: "Distribuidora Sur",
    });

    expect(await obtenerPartesReparto(99999)).toBeNull();
  });
});

describe("flujo gastos", () => {
  it("registra gastos y acumula el total", async () => {
    await crearGasto({
      fecha: "2026-09-13",
      categoria: "combustible",
      descripcion: "Nafta súper",
      montoCentavos: 15000,
    });
    await crearGasto({
      fecha: "2026-09-13",
      categoria: "mecanico",
      descripcion: "Cambio de aceite",
      montoCentavos: 2000,
    });

    const sept = await listarGastosDelMesConTotal("2026-09");
    expect(sept.totalCentavos).toBe(17000);
    expect(sept.gastos).toHaveLength(2);
  });

  it("filtra gastos por mes (YYYY-MM)", async () => {
    await crearGasto({
      fecha: "2026-09-10",
      categoria: "combustible",
      descripcion: "Septiembre 1",
      montoCentavos: 1000,
    });
    await crearGasto({
      fecha: "2026-09-01",
      categoria: "combustible",
      descripcion: "Septiembre 2",
      montoCentavos: 3000,
    });
    await crearGasto({
      fecha: "2026-08-25",
      categoria: "mecanico",
      descripcion: "Agosto 1",
      montoCentavos: 2000,
    });

    const septConTotal = await listarGastosDelMesConTotal("2026-09");
    expect(septConTotal.totalCentavos).toBe(4000);
    expect(septConTotal.gastos).toHaveLength(2);
    expect(septConTotal.gastos[0].descripcion).toBe("Septiembre 1");
    expect(septConTotal.gastos[1].descripcion).toBe("Septiembre 2");

    expect((await listarGastosDelMesConTotal("2026-08")).totalCentavos).toBe(2000);
    const vacioConTotal = await listarGastosDelMesConTotal("2026-07");
    expect(vacioConTotal.totalCentavos).toBe(0);
    expect(vacioConTotal.gastos).toHaveLength(0);
  });

  it("lista los gastos de UN día (Hoja de Ruta)", async () => {
    await crearGasto({
      fecha: "2026-09-13",
      categoria: "combustible",
      descripcion: "Nafta 13",
      montoCentavos: 15000,
    });
    await crearGasto({
      fecha: "2026-09-13",
      categoria: "otros",
      descripcion: "Peaje 13",
      montoCentavos: 3000,
    });
    await crearGasto({
      fecha: "2026-09-14",
      categoria: "mecanico",
      descripcion: "Cubierta 14",
      montoCentavos: 8000,
    });

    const delDia13 = (await obtenerHojaDeRutaDia("2026-09-13")).gastos;
    expect(delDia13).toHaveLength(2);
    expect(delDia13.reduce((t, g) => t + g.montoCentavos, 0)).toBe(18000);
    expect((await obtenerHojaDeRutaDia("2026-09-14")).gastos).toHaveLength(1);
    expect((await obtenerHojaDeRutaDia("2026-09-20")).gastos).toHaveLength(0);
  });
});

describe("métricas del dashboard", () => {
  it("cuenta repartos de hoy y los que faltan cobrar (hoy y en total)", async () => {
    const clienteId = await crearClienteBasico(15);
    const hoy = fechaHoyLocal();

    // 3 repartos hoy: uno cobrado (forma de pago) y dos sin cobrar.
    await crearReparto({ fecha: hoy, clienteId, formaPago: "contado" });
    await crearReparto({ fecha: hoy, clienteId });
    await crearReparto({ fecha: hoy, clienteId });

    // Fecha anterior sin cobrar: suma al total de sin cobrar, no al de hoy.
    await crearReparto({ fecha: "2026-09-01", clienteId });

    const metricas = await getMetricasDashboard();
    expect(metricas.repartosHoy).toBe(3);
    expect(metricas.repartosHoySinCobrar).toBe(2);
    // 2 sin cobrar de hoy + 1 del 01/09 = 3
    expect(metricas.repartosSinCobrarTotal).toBe(3);
  });
});

describe("migración de remitos a reparto", () => {
  it("reconstruye remitos sin cliente_id conservando los datos", async () => {
    const db = await getDb();

    // Simula una base en el formato viejo: remitos con cliente_id NOT NULL.
    await db.execute("DROP TABLE remito_items");
    await db.execute("DROP TABLE remitos");
    await db.execute(`CREATE TABLE remitos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      numero         INTEGER NOT NULL,
      cliente_id     INTEGER NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
      reparto_id     INTEGER REFERENCES repartos(id) ON DELETE SET NULL,
      fecha          TEXT NOT NULL DEFAULT (date('now')),
      estado         TEXT NOT NULL DEFAULT 'pendiente'
                     CHECK (estado IN ('pendiente', 'entregado', 'cancelado')),
      observaciones  TEXT,
      creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (numero)
    )`);
    await db.execute(`CREATE TABLE remito_items (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      remito_id                INTEGER NOT NULL REFERENCES remitos(id) ON DELETE CASCADE,
      descripcion              TEXT NOT NULL,
      cantidad                 REAL NOT NULL DEFAULT 1 CHECK (cantidad > 0),
      precio_unitario_centavos INTEGER NOT NULL DEFAULT 0 CHECK (precio_unitario_centavos >= 0)
    )`);
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_remito_items_remito ON remito_items(remito_id)",
    );
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_remitos_cliente ON remitos(cliente_id)",
    );
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_remitos_reparto ON remitos(reparto_id)",
    );

    const clienteId = await crearClienteBasico(40);
    const reparto = await crearReparto({
      fecha: "2026-09-13",
      clienteId,
      enviadoPor: "Cliente 40",
    });
    const remito = Number(
      (
        await db.execute(
          `INSERT INTO remitos (numero, cliente_id, reparto_id, fecha, estado)
           VALUES (?, ?, ?, ?, 'pendiente')`,
          [1, clienteId, reparto, "2026-09-13"],
        )
      ).lastInsertRowid,
    );
    await db.execute(
      `INSERT INTO remito_items (remito_id, descripcion, cantidad, precio_unitario_centavos)
       VALUES (?, ?, ?, ?)`,
      [remito, "Caja de agua", 1, 12000],
    );

    // La migración reconstruye la tabla sin cliente_id y conserva los datos.
    await migrate();

    const columnas = await db.execute(
      "SELECT name FROM pragma_table_info('remitos') WHERE name = 'cliente_id'",
    );
    expect(columnas.rows).toHaveLength(0);

    const completo = await obtenerRemitoCompleto(remito);
    expect(completo?.remito.repartoId).toBe(reparto);
    expect(completo?.clienteNombre).toBe("Cliente 40");
    expect(completo?.items).toHaveLength(1);

    // Idempotente: correrla de nuevo no rompe nada.
    await expect(migrate()).resolves.toBeUndefined();

    // Y ahora sí se puede borrar el cliente: los remitos ya no lo referencian,
    // solo los repartos (que quedan con cliente null).
    await eliminarCliente(clienteId);
    expect(await obtenerCliente(clienteId)).toBeNull();
    expect((await obtenerReparto(reparto))?.clienteId).toBeNull();
  });

  it("elimina siempre al cliente aunque la base siga en el esquema viejo (remitos.cliente_id bloqueante)", async () => {
    const db = await getDb();

    // Simula la base real sin migrar: remitos con cliente_id NOT NULL y FK
    // ON DELETE RESTRICT (el motivo original por el que no se podía borrar).
    await db.execute("DROP TABLE remito_items");
    await db.execute("DROP TABLE remitos");
    await db.execute(`CREATE TABLE remitos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      numero         INTEGER NOT NULL,
      cliente_id     INTEGER NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
      reparto_id     INTEGER REFERENCES repartos(id) ON DELETE SET NULL,
      fecha          TEXT NOT NULL DEFAULT (date('now')),
      estado         TEXT NOT NULL DEFAULT 'pendiente'
                     CHECK (estado IN ('pendiente', 'entregado', 'cancelado')),
      observaciones  TEXT,
      creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (numero)
    )`);
    await db.execute(`CREATE TABLE remito_items (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      remito_id                INTEGER NOT NULL REFERENCES remitos(id) ON DELETE CASCADE,
      descripcion              TEXT NOT NULL,
      cantidad                 REAL NOT NULL DEFAULT 1 CHECK (cantidad > 0),
      precio_unitario_centavos INTEGER NOT NULL DEFAULT 0 CHECK (precio_unitario_centavos >= 0)
    )`);
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_remitos_cliente ON remitos(cliente_id)",
    );

    const clienteId = await crearClienteBasico(41);
    const repartoId = await crearReparto({
      fecha: "2026-09-13",
      clienteId,
      enviadoPor: "Cliente 41",
    });
    const remito = Number(
      (
        await db.execute(
          `INSERT INTO remitos (numero, cliente_id, reparto_id, fecha, estado)
           VALUES (?, ?, ?, ?, 'pendiente')`,
          [1, clienteId, repartoId, "2026-09-13"],
        )
      ).lastInsertRowid,
    );

    // Acá el DELETE directo de clientes FALLARÍA por la FK RESTRICT. Pero
    // eliminarCliente primero deja el esquema al día (conserva el remito con
    // su reparto) y recién entonces borra al cliente.
    await expect(eliminarCliente(clienteId)).resolves.toBeUndefined();

    expect(await obtenerCliente(clienteId)).toBeNull();

    // El esquema quedó migrado y el remito no perdió su reparto.
    const columnas = await db.execute(
      "SELECT name FROM pragma_table_info('remitos') WHERE name = 'cliente_id'",
    );
    expect(columnas.rows).toHaveLength(0);

    const reparto = await obtenerReparto(repartoId);
    expect(reparto?.clienteId).toBeNull();
    expect(await listarRemitosDelReparto(repartoId)).toHaveLength(1);

    // El cliente sigue visible en el remito a través del "Envía" del reparto.
    const completo = await obtenerRemitoCompleto(remito);
    expect(completo?.remito.repartoId).toBe(repartoId);
    expect(completo?.clienteNombre).toBe("Cliente 41");
  });
});