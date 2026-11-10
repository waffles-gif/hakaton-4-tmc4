// Subida de imágenes (CP4). Flujo: preparar WebP sin metadatos → ticket → subir a Cloudinary con progreso → confirmar.
// - Re-codificar en un <canvas> descarta EXIF/XMP/ubicación: el WebP resultante solo trae píxeles.
// - Nada de librerías de recorte/compresión/subida: canvas.toBlob, crypto.subtle y XMLHttpRequest.upload.
import { ApiError, api } from '../../lib/api'

export type Purpose = 'BADGE' | 'INCIDENT'

export interface Ticket {
  ticketId: string
  expiresAt: string
  provider: 'SUPABASE' | 'CLOUDINARY'
  uploadPublicId?: string
  expectedPublicId?: string
  objectPath?: string
}

export interface Media {
  mediaId: number
  url: string
  width: number
  height: number
  purpose: Purpose
}

export interface PreparedImage {
  blob: Blob
  width: number
  height: number
  sha256: string
}

export const LIMITS = {
  BADGE: { maxBytes: 122_880, size: 512 },
  INCIDENT: { maxBytes: 307_200, minLong: 800, maxLong: 1600 },
} as const

export class MediaError extends Error {}

/** Decodifica el archivo elegido. Rechaza lo que no es imagen. */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) throw new MediaError('El archivo no es una imagen.')
  try {
    return await createImageBitmap(file)
  } catch {
    throw new MediaError('No se pudo leer la imagen.')
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Dibuja `src` (recortado a sx,sy,sw,sh) en un canvas de outW×outH y lo exporta como WebP,
 * bajando la calidad hasta entrar en `maxBytes`.
 */
export async function renderWebp(
  src: CanvasImageSource,
  crop: { sx: number; sy: number; sw: number; sh: number },
  outW: number,
  outH: number,
  maxBytes: number,
): Promise<PreparedImage> {
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new MediaError('El navegador no permite dibujar en canvas.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH)

  for (const q of [0.92, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25]) {
    const blob = await toBlob(canvas, q)
    if (!blob || blob.type !== 'image/webp') {
      throw new MediaError('Este navegador no puede generar imágenes WebP. Prueba con Chrome, Edge o Firefox.')
    }
    if (blob.size <= maxBytes) return { blob, width: outW, height: outH, sha256: await sha256Hex(blob) }
  }
  throw new MediaError('No se pudo comprimir la imagen por debajo del peso máximo.')
}

/** Foto de incidencia: lado mayor entre 800 y 1600, sin recorte. */
export async function prepareIncidentPhoto(file: Blob): Promise<PreparedImage> {
  const bmp = await decodeImage(file)
  const long = Math.max(bmp.width, bmp.height)
  const target = Math.min(LIMITS.INCIDENT.maxLong, Math.max(LIMITS.INCIDENT.minLong, long))
  const scale = target / long
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  try {
    return await renderWebp(bmp, { sx: 0, sy: 0, sw: bmp.width, sh: bmp.height }, w, h, LIMITS.INCIDENT.maxBytes)
  } finally {
    bmp.close()
  }
}

export function requestTicket(purpose: Purpose, img: PreparedImage): Promise<Ticket> {
  return api<Ticket>('/media/tickets', {
    method: 'POST',
    body: {
      purpose,
      contentType: 'image/webp',
      bytes: img.blob.size,
      sha256: img.sha256,
      width: img.width,
      height: img.height,
    },
  })
}

/** Subida directa a Cloudinary (preset unsigned) con progreso real y cancelable. Devuelve la secure_url. */
export function uploadToCloudinary(
  blob: Blob,
  ticket: Ticket,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<string> {
  const cloud = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
  if (!cloud || !preset) return Promise.reject(new MediaError('Falta configurar Cloudinary (variables VITE_CLOUDINARY_*).'))
  if (ticket.provider !== 'CLOUDINARY' || !ticket.uploadPublicId) {
    return Promise.reject(new MediaError('El storage registrado no es Cloudinary.'))
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* sin cuerpo JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object' && 'secure_url' in body) {
        onProgress(1)
        resolve(String(body.secure_url))
      } else {
        const msg =
          body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'message' in body.error
            ? String(body.error.message)
            : `HTTP ${xhr.status}`
        reject(new MediaError(`Cloudinary rechazó la subida: ${msg}`))
      }
    }
    xhr.onerror = () => reject(new MediaError('Error de red al subir la imagen.'))
    xhr.onabort = () => reject(new DOMException('Subida cancelada', 'AbortError'))
    signal.addEventListener('abort', () => xhr.abort())

    const form = new FormData()
    form.append('file', blob, 'image.webp')
    form.append('upload_preset', preset)
    form.append('public_id', ticket.uploadPublicId ?? '')
    xhr.send(form)
  })
}

export function confirmTicket(ticketId: string, url: string): Promise<Media> {
  return api<Media>(`/media/tickets/${encodeURIComponent(ticketId)}/confirm`, { method: 'POST', body: { url } })
}

/** Texto accionable para cualquier error del flujo. */
export function mediaErrorText(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return 'Subida cancelada.'
  if (e instanceof MediaError) return e.message
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'STORAGE_NOT_VERIFIED':
        return 'El storage del equipo todavía no está verificado.'
      case 'CLEARANCE_REQUIRED':
        return 'El Piso de Pruebas está cerrado.'
      case 'TICKET_EXPIRED':
        return 'El permiso de subida venció. Reintenta.'
      case 'MEDIA_CONSTRAINTS':
      case 'MEDIA_VERIFICATION_FAILED': {
        const d = e.details
        const reason = d && typeof d === 'object' && 'reason' in d ? ` (${String(d.reason)})` : ''
        return `La imagen no cumple los requisitos${reason}.`
      }
      default:
        return e.message
    }
  }
  return 'Error inesperado.'
}

/** Ticket → subida → confirmación. */
export async function uploadPrepared(
  purpose: Purpose,
  img: PreparedImage,
  onProgress: (f: number) => void,
  signal: AbortSignal,
): Promise<Media> {
  const ticket = await requestTicket(purpose, img)
  if (signal.aborted) throw new DOMException('Subida cancelada', 'AbortError')
  const url = await uploadToCloudinary(img.blob, ticket, onProgress, signal)
  return confirmTicket(ticket.ticketId, url)
}
