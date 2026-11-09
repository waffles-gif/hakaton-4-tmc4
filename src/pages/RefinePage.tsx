import { useParams } from 'react-router'

// Placeholder para la persona B (CP2): grilla virtualizada /files/:id/refine.
// Se carga con lazy() para que NO entre en el bundle inicial.
export default function RefinePage() {
  const { id } = useParams()
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Refinar archivo {id}</h1>
      <p className="mt-2 text-slate-300">Próximamente.</p>
    </main>
  )
}
