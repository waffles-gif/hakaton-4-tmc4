// Lógica pura (sin React): decodificar tiles, BFS de grupos y cálculo de la caja.
import type { Bin, Cell, Rules, TileDto } from './types'

/** Tile ya decodificado: arrays planos indexados por (fila local * cols + col local). */
export interface Tile {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  /** Dígito 0..9 por celda. */
  values: Uint8Array
  /** Temblor 0..100 por celda (base64 → bytes). */
  tremor: Uint8Array
  /** '.', 'W', 'F', 'D' o 'M' por celda. */
  bins: string[]
  version: number
}

/** base64 → bytes. atob devuelve un "binary string": cada char es un byte (0..255). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function decodeTile(dto: TileDto): Tile {
  const n = dto.rows * dto.cols
  const values = new Uint8Array(n)
  for (let i = 0; i < n; i++) values[i] = dto.values.charCodeAt(i) - 48 // '0' = 48
  const tremor = base64ToBytes(dto.tremor)
  if (tremor.length !== n || dto.values.length !== n || dto.bins.length !== n) {
    throw new Error(`Tile ${dto.tileRow},${dto.tileCol} inconsistente`)
  }
  return {
    tileRow: dto.tileRow,
    tileCol: dto.tileCol,
    originRow: dto.originRow,
    originCol: dto.originCol,
    rows: dto.rows,
    cols: dto.cols,
    values,
    tremor,
    bins: dto.bins.split(''),
    version: dto.version,
  }
}

export const tileKey = (tr: number, tc: number) => `${tr}:${tc}`
export const cellKey = (r: number, c: number) => `${r}:${c}`

export function tileOfCell(r: number, c: number, tileSize: number) {
  return { tr: Math.floor(r / tileSize), tc: Math.floor(c / tileSize) }
}

export interface CellInfo {
  value: number
  tremor: number
  bin: string
}

export function cellFromTile(tile: Tile, r: number, c: number): CellInfo {
  const i = (r - tile.originRow) * tile.cols + (c - tile.originCol)
  return { value: tile.values[i] ?? 0, tremor: tile.tremor[i] ?? 0, bin: tile.bins[i] ?? '.' }
}

export function isScary(tremor: number, rules: Rules) {
  return tremor >= rules.tremorThreshold
}

const N4: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]]
const N8: ReadonlyArray<readonly [number, number]> = [
  ...N4, [-1, -1], [-1, 1], [1, -1], [1, 1],
]

export interface GroupResult {
  cells: Cell[]
  /** Suma y máximo de los dígitos del grupo. */
  digitSum: number
  maxDigit: number
  /** true si BFS se cortó por pasar maxGroupSize (ya es ruido seguro). */
  truncated: boolean
  /** true si alguna celda ya está en una caja. */
  alreadyRefined: boolean
}

/**
 * BFS desde (r0,c0) sobre las celdas que dan miedo. `getCell` es async porque
 * puede tener que pedir tiles que faltan (el grupo cruza bloques).
 * Se corta en maxGroupSize + 1: a partir de ahí ya es ruido y no hace falta pedir más tiles.
 */
export async function findGroup(
  r0: number,
  c0: number,
  rows: number,
  cols: number,
  rules: Rules,
  getCell: (r: number, c: number) => Promise<CellInfo>,
): Promise<GroupResult | null> {
  const start = await getCell(r0, c0)
  if (!isScary(start.tremor, rules)) return null

  const neigh = rules.connectivity === 8 ? N8 : N4
  const seen = new Set<string>([cellKey(r0, c0)])
  const queue: Cell[] = [{ r: r0, c: c0 }]
  const cells: Cell[] = []
  let digitSum = 0
  let maxDigit = 0
  let alreadyRefined = false
  const limit = rules.maxGroupSize + 1

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!
    const info = await getCell(cur.r, cur.c)
    cells.push(cur)
    digitSum += info.value
    maxDigit = Math.max(maxDigit, info.value)
    if (info.bin !== '.') alreadyRefined = true
    if (cells.length >= limit) {
      return { cells, digitSum, maxDigit, truncated: true, alreadyRefined }
    }
    for (const [dr, dc] of neigh) {
      const r = cur.r + dr
      const c = cur.c + dc
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue
      const k = cellKey(r, c)
      if (seen.has(k)) continue
      seen.add(k)
      const n = await getCell(r, c)
      if (isScary(n.tremor, rules)) queue.push({ r, c })
    }
  }
  return { cells, digitSum, maxDigit, truncated: false, alreadyRefined }
}

export function isNoise(group: GroupResult, rules: Rules) {
  return group.truncated || group.cells.length < rules.minGroupSize || group.cells.length > rules.maxGroupSize
}

/** Caja según las reglas: order[(suma o máximo) % 4]. */
export function binFor(group: GroupResult, rules: Rules): Bin {
  const base = rules.binning.strategy === 'DIGIT_SUM_MOD' ? group.digitSum : group.maxDigit
  const bin = rules.binning.order[base % 4]
  if (!bin) throw new Error('binning.order inválido')
  return bin
}

export const BIN_CHAR: Record<Bin, string> = { WO: 'W', FC: 'F', DR: 'D', MA: 'M' }
