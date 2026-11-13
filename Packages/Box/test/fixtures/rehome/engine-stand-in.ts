// The engine's HTTP API for a move's check, as `opencode serve --stdio --port 0` answers it, read
// from the database it's started on (`$XDG_DATA_HOME/opencode/opencode.db`): its sessions' list
// and each session. It says where it listens as its first line and stops when its stdin closes.
// The move's tests start it in the engine's place; one test starts the real engine instead.
import { Database } from "bun:sqlite"

const db = new Database(`${process.env.XDG_DATA_HOME}/opencode/opencode.db`, { readonly: true })
const authorization = "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")
const session = (row: any) => ({ id: row.id, projectID: row.project_id, location: { directory: row.directory } })
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.headers.get("authorization") !== authorization) return new Response("", { status: 401 })
    const url = new URL(request.url)
    if (url.pathname === "/api/session") {
      const archived = url.searchParams.get("archived") === "true"
      const rows = db.query(`SELECT * FROM session_v2 WHERE time_archived IS ${archived ? "NOT " : ""}NULL ORDER BY time_updated DESC`).all()
      return Response.json({ data: rows.map(session), cursor: { previous: null, next: null } })
    }
    const one = /^\/api\/session\/([^/]+)$/.exec(url.pathname)
    if (one) {
      const row = db.query("SELECT * FROM session_v2 WHERE id = ?").get(decodeURIComponent(one[1]))
      return row ? Response.json({ data: session(row) }) : new Response("", { status: 404 })
    }
    return new Response("", { status: 404 })
  },
})
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }))
process.stdin.on("end", () => process.exit(0))
process.stdin.resume()
