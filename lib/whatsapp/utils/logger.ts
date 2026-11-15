// lib/whatsapp/utils/logger.ts
// Small shared logger for the WhatsApp services. Writes one line per event to the console
// (Vercel shows these in Runtime Logs). Never throws, so logging can't break a reply.

type Meta = Record<string, unknown> | undefined

function write(level: "debug" | "info" | "warn" | "error", message: string, meta?: Meta) {
  try {
    const line = meta === undefined ? message : `${message} ${JSON.stringify(meta, replacer)}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else if (level === "debug") {
      if (process.env.NODE_ENV !== "production") console.debug(line)
    } else console.info(line)
  } catch {
    // never let logging fail
  }
}

function replacer(_key: string, value: unknown) {
  return value instanceof Error ? { name: value.name, message: value.message } : value
}

export const logger = {
  debug: (message: string, meta?: Meta) => write("debug", message, meta),
  info: (message: string, meta?: Meta) => write("info", message, meta),
  warn: (message: string, meta?: Meta) => write("warn", message, meta),
  error: (message: string, meta?: Meta) => write("error", message, meta),
}
