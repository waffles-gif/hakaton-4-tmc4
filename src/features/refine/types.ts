// Tipos del contrato (Swagger): /files, /files/{id}, /rules, /tiles, /refinements.

export type Bin = 'WO' | 'FC' | 'DR' | 'MA'
export const BINS: readonly Bin[] = ['WO', 'FC', 'DR', 'MA']

export type Progress = Record<Bin, number> & { overall: number }

export type FileStatus = 'ACTIVE' | 'COMPLETE'

export interface LumonFile {
  id: number
  name: string
  rows: number
  cols: number
  tileSize: number
  status: FileStatus
  progress: Progress
  refinedGroups: number
  totalGroups: number
  mistakes: number
  updatedAt: string
}

export interface FilePage {
  content: LumonFile[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export interface Rules {
  tremorThreshold: number
  connectivity: 4 | 8
  minGroupSize: number
  maxGroupSize: number
  binning: { strategy: 'DIGIT_SUM_MOD' | 'MAX_DIGIT_MOD'; order: Bin[] }
}

/** Respuesta cruda de GET /files/{id}/tiles/{tileRow}/{tileCol}. */
export interface TileDto {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  values: string
  tremor: string
  bins: string
  version: number
}

export interface RefineResult {
  refinementId: number
  bin: Bin
  size: number
  file: {
    progress: Progress
    refinedGroups: number
    totalGroups: number
    mistakes: number
    status: FileStatus
  }
}

export interface Cell {
  r: number
  c: number
}
