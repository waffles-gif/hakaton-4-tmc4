// Contrato (Swagger) de /departments y /refiners.

export interface Department {
  id: number
  code: string
  name: string
}

export interface Badge {
  url: string
  width: number
  height: number
}

/** Los textos vienen del exterior: se muestran SIEMPRE como texto (nunca HTML). */
export interface Refiner {
  id: number
  fullName: string
  department: Department
  title: string
  extension: string
  bio: string
  profileUrl: string | null
  badge: Badge | null
  version: number
  updatedAt: string
}

export interface RefinerPage {
  content: Refiner[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export interface RefinerPatch {
  title?: string
  extension?: string
  bio?: string
  departmentId?: number
  badgeMediaId?: number | null
}

/** Solo se enlazan URLs http(s): `profileUrl` puede traer javascript: u otros esquemas. */
export function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
