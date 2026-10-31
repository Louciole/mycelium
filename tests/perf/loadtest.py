"""Tiny HTTP load generator (stdlib only) to measure the Mycelium server.

    python tests/perf/loadtest.py [--url http://127.0.0.1:9876] [-c 8] [-d 10] [scenario ...]

Each scenario hammers one or more paths with `-c` keep-alive connections for
`-d` seconds and prints req/s and latency percentiles. Authenticated scenarios
first create a throw-away verified account through the DEBUG OTP flow (the
same one the E2E tests use), so the server must run with DEBUG = true.
"""
import argparse
import asyncio
import json
import time
import urllib.parse

SCENARIOS = {
    # static-ish: the routing/response cost of the framework, no DB
    "config": ["/config"],
    # authenticated, one cheap query
    "user_info": ["/get_user_info"],
    # what a client fetches on boot (static/main.mjs), round-robin
    "boot": ["/get_user_info", "/get_user_servers", "/get_user_convs", "/get_friends",
             "/get_friend_invitations", "/get_blocked"],
    # 404 through the `default` route (an invitation lookup)
    "notfound": ["/capacitor.js"],
    # a whole account creation (login -> OTP -> signup), what every E2E test starts with
    "signup": [None],
}
NEEDS_AUTH = {"user_info", "boot"}


class Conn:
    def __init__(self, host, port):
        self.host, self.port = host, port
        self.reader = self.writer = None

    async def open(self):
        self.reader, self.writer = await asyncio.open_connection(self.host, self.port)

    async def request(self, method, path, cookie=None):
        if self.writer is None:
            await self.open()
        head = f"{method} {path} HTTP/1.1\r\nHost: {self.host}\r\nConnection: keep-alive\r\n"
        if cookie:
            head += f"Cookie: {cookie}\r\n"
        if method == "POST":
            head += "Content-Length: 0\r\n"
        self.writer.write((head + "\r\n").encode())
        status_line = await self.reader.readline()
        if not status_line:
            raise ConnectionError("closed")
        status = int(status_line.split()[1])
        headers = {}
        cookies = []
        while True:
            line = await self.reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            k, _, v = line.decode().partition(":")
            if k.lower() == "set-cookie":
                cookies.append(v.strip())
            headers[k.lower()] = v.strip()
        if "content-length" in headers:
            body = await self.reader.readexactly(int(headers["content-length"]))
        elif headers.get("transfer-encoding") == "chunked":
            body = b""
            while True:
                size = int((await self.reader.readline()).strip(), 16)
                if size == 0:
                    await self.reader.readline()
                    break
                body += await self.reader.readexactly(size)
                await self.reader.readline()
        else:   # no length: read until close
            body = await self.reader.read()
            self.writer.close()
            self.writer = None
        if headers.get("connection", "").lower() == "close" and self.writer:
            self.writer.close()
            self.writer = None
        return status, body, cookies


async def create_account(host, port):
    """Verified throw-away account, returns the Cookie header to send."""
    jar = {}

    def keep(cookies):
        for c in cookies:
            name, _, rest = c.partition("=")
            jar[name] = rest.split(";")[0]

    def cookie():
        return "; ".join(f"{k}={v}" for k, v in jar.items())

    email = f"loadtest_{time.time_ns()}@test.com"
    q = urllib.parse.urlencode({"email": email, "password": "loadtest-pass"})
    conn = Conn(host, port)
    status, body, cookies = await conn.request("POST", f"/login?{q}")
    keep(cookies)
    assert body == b"verif", (status, body)
    _, body, _ = await conn.request("POST", f"/get_debug_otp?email={urllib.parse.quote(email)}")
    code = json.loads(body)["code"]
    status, body, cookies = await conn.request("POST", f"/signup?code={code}", cookie())
    keep(cookies)
    assert body == b"ok", (status, body)
    return cookie()


async def run_scenario(host, port, paths, concurrency, duration, cookie):
    latencies, statuses = [], {}
    deadline = time.monotonic() + duration

    async def worker(offset):
        conn = Conn(host, port)
        i = offset
        while time.monotonic() < deadline:
            path = paths[i % len(paths)]
            i += 1
            t0 = time.perf_counter()
            try:
                if path is None:
                    await create_account(host, port)
                    status = "ok"
                else:
                    status, _, _ = await conn.request("GET", path, cookie)
            except (ConnectionError, OSError, asyncio.IncompleteReadError, ValueError):
                status = "err"
                conn = Conn(host, port)
            latencies.append(time.perf_counter() - t0)
            statuses[status] = statuses.get(status, 0) + 1

    t0 = time.monotonic()
    await asyncio.gather(*(worker(i) for i in range(concurrency)))
    elapsed = time.monotonic() - t0
    latencies.sort()

    def pct(p):
        return latencies[min(len(latencies) - 1, int(len(latencies) * p))] * 1000

    return {"rps": len(latencies) / elapsed, "n": len(latencies), "p50": pct(.5),
            "p90": pct(.9), "p99": pct(.99), "max": latencies[-1] * 1000, "statuses": statuses}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:9876")
    ap.add_argument("-c", "--concurrency", type=int, default=8)
    ap.add_argument("-d", "--duration", type=float, default=10)
    ap.add_argument("scenarios", nargs="*", default=list(SCENARIOS), help="scenario names or raw paths")
    args = ap.parse_args()
    url = urllib.parse.urlparse(args.url)
    host, port = url.hostname, url.port or 80

    cookie = None
    if NEEDS_AUTH & set(args.scenarios):
        cookie = await create_account(host, port)

    for name in args.scenarios:
        paths = SCENARIOS.get(name) or [name]   # or any raw path, e.g. /static/main.html
        r = await run_scenario(host, port, paths, args.concurrency, args.duration, cookie)
        unit = "flows/s" if name == "signup" else "req/s"
        print(f"{name:10s} c={args.concurrency:<3d} {r['rps']:8.1f} {unit:7s} p50 {r['p50']:7.2f} ms"
              f"   p90 {r['p90']:7.2f}   p99 {r['p99']:7.2f}   max {r['max']:8.2f}   {r['statuses']}",
              flush=True)


if __name__ == "__main__":
    asyncio.run(main())
