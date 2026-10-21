/** One Server-Sent Event. */
export type SseMessage = { event: string; data: string; id: string | null }

/**
 * Splits a text stream into Server-Sent Events. Comment lines (": ping") count as activity but
 * produce no event. Call `push` with each decoded chunk; complete events go to `onMessage`.
 */
export function createSseParser(onMessage: (msg: SseMessage) => void) {
  let buffer = ""
  return function push(chunk: string) {
    // Normalise the whole buffer: a "\r\n" can be split across two chunks.
    buffer = (buffer + chunk).replace(/\r\n/g, "\n")
    let end: number
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = "message"
      let id: string | null = null
      const data: string[] = []
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
        if (field === "event") event = value
        else if (field === "data") data.push(value)
        else if (field === "id") id = value
      }
      if (data.length) onMessage({ event, data: data.join("\n"), id })
    }
  }
}
