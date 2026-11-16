/** Minimal picture files: only the header bytes the size readers look at. */
export function pngBytes(width: number, height: number, salt = 0): Buffer {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  head[29] = salt
  return head
}

export function jpegBytes(width: number, height: number): Buffer {
  const data = Buffer.alloc(24)
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(data, 0)
  data.writeUInt16BE(height, 7)
  data.writeUInt16BE(width, 9)
  return data
}

export function webpBytes(width: number, height: number): Buffer {
  const data = Buffer.alloc(32)
  data.write('RIFF', 0, 'ascii')
  data.writeUInt32LE(24, 4)
  data.write('WEBP', 8, 'ascii')
  data.write('VP8X', 12, 'ascii')
  data.writeUInt32LE(10, 16)
  data.writeUIntLE(width - 1, 24, 3)
  data.writeUIntLE(height - 1, 27, 3)
  return data
}
