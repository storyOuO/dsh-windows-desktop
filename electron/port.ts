/**
 * Free-port allocation: ask the OS for an ephemeral port by binding to port 0,
 * then immediately releasing the socket so dsh can rebind.
 * @module electron/port
 */

import { createServer } from 'node:net'

/**
 * Resolve a free TCP port the OS guarantees is available at call time.
 * The caller must bind before any third party grabs it; the guarantee is
 * point-in-time, not a reservation.
 * @returns a free TCP port number.
 * @throws when the OS cannot allocate a port (rare: exhausted ephemeral range).
 */
export async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('port: listen returned unexpected address'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}
