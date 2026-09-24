"use client";

import { useActionState } from "react";
import type { EstadoAction } from "@/app/actions/estado";
import { estadoInicial } from "@/app/actions/estado";
import { Button, FormError } from "@/app/components/ui/form";

type AccionEliminar = (
  estado: EstadoAction,
  formData: FormData,
) => Promise<EstadoAction>;

export function ConfirmDeleteButton({
  action,
  id,
  confirmMessage,
  label,
  pendingLabel = "Eliminando…",
  variant = "danger",
  formClassName = "space-y-2",
}: {
  action: AccionEliminar;
  id: number;
  confirmMessage: string;
  label: string;
  pendingLabel?: string;
  variant?: "danger" | "ghost";
  formClassName?: string;
}) {
  const [estado, formAction, pending] = useActionState(action, estadoInicial);

  return (
    <form
      action={formAction}
      onSubmit={(evento) => {
        if (!window.confirm(confirmMessage)) {
          evento.preventDefault();
        }
      }}
      className={formClassName}
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      <FormError message={estado.error} />
    </form>
  );
}
