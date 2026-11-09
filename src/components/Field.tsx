import { useId, type InputHTMLAttributes } from 'react'

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  error?: string
}

/** Input con label y error del servidor junto al campo (accesible). */
export function Field({ label, error, ...input }: Props) {
  const id = useId()
  const errId = `${id}-err`
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-200">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        className="rounded border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100 focus:border-teal-400 focus:outline-none"
        {...input}
      />
      {error && (
        <p id={errId} className="text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  )
}
