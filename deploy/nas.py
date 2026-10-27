"""NAS 全自动部署助手：python deploy/nas.py <probe|push|up|signin|status|...>

凭据从环境变量读取（也可用 .env 的 NAS_* 段）：
  NAS_HOST / NAS_USER / NAS_PASS / NAS_REMOTE_DIR / NAS_PROXY_URL
"""
import json
import os
import re
import sys
import time

import paramiko
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

HOST = os.environ.get("NAS_HOST", "")
USER = os.environ.get("NAS_USER", "dan")
PASSWORD = os.environ.get("NAS_PASS", "")
REMOTE_DIR = os.environ.get("NAS_REMOTE_DIR", "/home/dan/bscagentmint")
# 部署到 NAS 时写入其 .env 的代理地址；留空表示直连
NAS_PROXY_URL = os.environ.get("NAS_PROXY_URL", "")

if not HOST or not PASSWORD:
    sys.exit("请先设置 NAS_HOST / NAS_PASS 环境变量（不要把凭据写进代码）")

UPLOAD_FILES = [
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore",
    "package.json",
    "probe-stream.mjs",
    "src/config.js", "src/logger.js", "src/proxy.js", "src/state.js", "src/rpc.js",
    "src/stream.js", "src/classify.js", "src/baw.js", "src/minter.js", "src/telegram.js",
    "src/index.js",
    "scripts/signin.mjs", "scripts/test-telegram.mjs", "scripts/test-classify.mjs",
]


def connect():
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, username=USER, password=PASSWORD, timeout=15)
    return cli


def run(cli, cmd, timeout=120):
    """执行命令；优先 docker，权限不足自动加 sudo -S"""
    for prefix in ("", "sudo -S "):
        full = prefix + cmd
        stdin, stdout, stderr = cli.exec_command(full, timeout=timeout, get_pty=True)
        if prefix:
            stdin.write(PASSWORD + "\n")
            stdin.flush()
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        combined = out + err
        if "is not in the sudoers file" in combined or "Permission denied" in combined and prefix:
            break
        if prefix == "" and ("permission denied" in combined.lower() or "cannot connect to the Docker daemon" in combined):
            continue
        return combined
    return combined


def probe(cli):
    print(run(cli, "uname -a"))
    print(run(cli, "cat /etc/os-release | head -3"))
    print("docker:", run(cli, "docker --version"))
    print("compose:", run(cli, "docker compose version"))
    print("id:", run(cli, "id"))
    print("df:", run(cli, "df -h ~ | tail -1"))


def push(cli):
    # 远端已配置的字段（Telegram/每日上限等运行期设置）优先于本地，避免部署覆盖
    REMOTE_KEEP = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "MAX_MINTS_PER_DAY", "MINT_UNKNOWN_PRICE")
    remote_env = {}
    out = run(cli, f"cat {REMOTE_DIR}/.env 2>/dev/null || true")
    for line in out.splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m and m.group(1) in REMOTE_KEEP and m.group(2).strip():
            remote_env[m.group(1)] = m.group(2)

    sftp = cli.open_sftp()
    run(cli, f"mkdir -p {REMOTE_DIR}/src {REMOTE_DIR}/scripts")
    for f in UPLOAD_FILES:
        local = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), f)
        with open(local, "r", encoding="utf-8") as fh:
            content = fh.read()
        if f == ".env":
            content = re.sub(r"^PROXY_URL=.*$", f"PROXY_URL={NAS_PROXY_URL}", content, flags=re.M)
            for k, v in remote_env.items():
                if re.search(rf"^{k}=.*$", content, flags=re.M):
                    content = re.sub(rf"^{k}=.*$", f"{k}={v}", content, flags=re.M)
                else:
                    content += f"\n{k}={v}"
        remote = f"{REMOTE_DIR}/{f}"
        with sftp.open(remote, "w") as rf:
            rf.write(content)
        print("pushed", f)
    # .env 单独处理（不在 UPLOAD_FILES 里的敏感项）
    env_local = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    with open(env_local, "r", encoding="utf-8") as fh:
        content = fh.read()
    content = re.sub(r"^PROXY_URL=.*$", f"PROXY_URL={NAS_PROXY_URL}", content, flags=re.M)
    for k, v in remote_env.items():
        if re.search(rf"^{k}=.*$", content, flags=re.M):
            content = re.sub(rf"^{k}=.*$", f"{k}={v}", content, flags=re.M)
        else:
            content += f"\n{k}={v}"
    with sftp.open(f"{REMOTE_DIR}/.env", "w") as rf:
        rf.write(content)
    print("pushed .env (PROXY_URL->NAS, remote-only fields preserved)")


def safe_print(s):
    try:
        print(s)
    except UnicodeEncodeError:
        import sys as _sys
        _sys.stdout.buffer.write(s.encode("utf-8", "replace") + b"\n")


def up(cli):
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose up -d --build", timeout=900)[-3000:])


def signin(cli):
    # 后台起独立登录容器（共享 baw-session 卷），轮询容器日志拿二维码链接
    run(cli, f"docker rm -f baw-signin 2>/dev/null; true")
    run(cli, f"cd {REMOTE_DIR} && docker compose run -d --name baw-signin bscagentmint node scripts/signin.mjs")
    out = ""
    for _ in range(15):
        time.sleep(2)
        out = run(cli, "docker logs baw-signin 2>&1")
        m = re.search(r"https://app\.binance\.com/uni-qr/\S+", out)
        if m:
            safe_print("QR_URL=" + m.group(0))
            pm = re.search(r"pairingCode[^,}]*", out)
            if pm:
                safe_print(pm.group(0))
            safe_print("扫码后登录容器会自动完成并退出；主服务会在下一个事件时自动感知登录（懒检测）。")
            return
    safe_print("未拿到二维码链接，baw-signin 日志：")
    safe_print(out[-1500:])


def status(cli):
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose ps"))
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose logs --tail 25"))
    safe_print("baw: " + run(cli, f"cd {REMOTE_DIR} && docker compose run --rm bscagentmint node -e \"import('./src/baw.js').then(async m=>console.log(await m.wallet.status()))\" 2>&1 | tail -3"))


def net(cli):
    for url in [
        "https://mintgo.fun",
        "https://api.binance.com",
        "https://registry.npmmirror.com",
        "https://docker.m.daocloud.io/v2/",
        "https://docker.1ms.run/v2/",
        "https://hub.rat.dev/v2/",
    ]:
        out = run(cli, f"curl -sS -o /dev/null -w '%{{http_code}} %{{time_total}}s' --max-time 10 {url} 2>&1")
        safe_print(f"{url} -> {out.strip().splitlines()[-1] if out.strip() else '?'}")


def dnsdiag(cli):
    for host in ["api.binance.com", "bapi.binance.com", "app.binance.com"]:
        safe_print(f"== {host}")
        safe_print("  system: " + run(cli, f"getent hosts {host} | head -2").strip().replace("\n", " | "))
        safe_print("  alidns53: " + run(cli, f"nslookup {host} 223.5.5.5 2>/dev/null | tail -4").strip().replace("\n", " | "))
        safe_print("  alidoh: " + run(cli, f"curl -sS --max-time 8 'https://dns.alidns.com/resolve?name={host}&type=A' | head -c 400"))
    # 用阿里 DoH 返回的 IP 直连验证链路
    out = run(cli, "curl -sS --max-time 8 'https://dns.alidns.com/resolve?name=api.binance.com&type=A'")
    ips = re.findall(r'"data":"(\d+\.\d+\.\d+\.\d+)"', out)
    for ip in ips[:2]:
        safe_print(f"  direct {ip}: " + run(cli, f"curl -sS -o /dev/null -w '%{{http_code}} %{{time_total}}s' --max-time 10 --resolve api.binance.com:443:{ip} https://api.binance.com 2>&1").strip())


def proxdiag(cli):
    safe_print("== listening ports (proxy-like)")
    safe_print(run(cli, "ss -tlnp 2>/dev/null | grep -E ':(7890|7891|7897|7899|1080|8888|8889|10808|20171|20172)\\b' || true"))
    safe_print("== all docker containers")
    safe_print(run(cli, "docker ps -a --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'"))
    safe_print("== gateway")
    safe_print(run(cli, "ip route | head -3"))
    safe_print("== try common local proxies against binance")
    for port in [7890, 7891, 7897, 1080, 8889]:
        out = run(cli, f"curl -sS -o /dev/null -w '%{{http_code}}' --max-time 8 -x http://127.0.0.1:{port} https://api.binance.com 2>&1")
        safe_print(f"  127.0.0.1:{port} -> {out.strip().splitlines()[-1] if out.strip() else '?'}")


def bapitest(cli):
    for url in [
        "https://bapi.binance.com/bapi/defi/v1/public/wallet-direct/agent-wallet/settings/query",
        "https://app.binance.com/",
        "https://mintgo.fun/",
    ]:
        out = run(cli, f"curl -sS -o /dev/null -w '%{{http_code}} %{{time_total}}s' --max-time 12 -x http://127.0.0.1:7890 {url} 2>&1")
        safe_print(f"  via7890 {url} -> {out.strip().splitlines()[-1] if out.strip() else '?'}")


def setenv_var(cli, key, value):
    """改 NAS .env 里的一个变量；value 为空则删除该行"""
    if value:
        run(cli, f"cd {REMOTE_DIR} && sed -i 's|^{key}=.*|{key}={value}|' .env && grep -q '^{key}=' .env || echo '{key}={value}' >> .env")
    else:
        run(cli, f"cd {REMOTE_DIR} && sed -i '/^{key}=/d' .env")
    safe_print(run(cli, f"cd {REMOTE_DIR} && grep -E '^(PROXY_URL|TELEGRAM)' .env"))


def bawstatus(cli):
    safe_print("baw: " + run(cli, f"cd {REMOTE_DIR} && docker compose run --rm bscagentmint node -e \"import('./src/baw.js').then(async m=>console.log(await m.wallet.status()))\" 2>&1 | tail -2").strip())
    safe_print(run(cli, "docker ps -a --format '{{.Names}} {{.Status}}' | grep -E 'bscagentmint|baw-signin'"))


def testtg(cli):
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose run --rm bscagentmint node scripts/test-telegram.mjs 2>&1 | tail -3"))


def address(cli):
    code = "import('./src/baw.js').then(async m=>{const a=await m.wallet.address();const g=await m.wallet.agentId().catch(()=>null);console.log('ADDR='+a+' AGENT='+g)})"
    out = run(cli, f"cd {REMOTE_DIR} && docker compose run --rm bscagentmint node -e \"{code}\" 2>&1 | grep ADDR")
    safe_print(out.strip())


def getenv_var(cli, keys):
    pat = "|".join(re.escape(k) for k in keys)
    out = run(cli, f"cd {REMOTE_DIR} && grep -E '^({pat})=' .env")
    safe_print(out.strip())


def fails(cli):
    sftp = cli.open_sftp()
    tmp = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "nas-state.json")
    try:
        sftp.get(f"{REMOTE_DIR}/data/state.json", tmp)
    finally:
        sftp.close()
    d = json.load(open(tmp, encoding="utf-8"))
    safe_print(f"每日已 mint: {d.get('mintedToday')}  attempts 总数: {len(d.get('attempts', {}))}")
    for k, v in d.get("attempts", {}).items():
        if v.get("status") != "minted":
            safe_print(f"--- {v.get('status')} {k} {v.get('at','')}")
            if v.get("reason"):
                safe_print("    " + v["reason"][:400].replace("\n", " ⏎ "))
            if v.get("txHash"):
                safe_print("    tx=" + v["txHash"])


def diag(cli):
    safe_print("== container status")
    safe_print(run(cli, 'docker ps -a --format "{{.Names}} {{.Status}}"'))
    safe_print(run(cli, 'docker inspect bscagentmint --format "RestartCount={{.RestartCount}} StartedAt={{.State.StartedAt}} Status={{.State.Status}} OOM={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}"'))
    safe_print("== last 40 log lines")
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose logs --tail 40 2>&1 | sed 's/\\x1b\\[[0-9;]*m//g'"))
    safe_print("== recent errors (24h)")
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose logs --since 24h 2>&1 | sed 's/\\x1b\\[[0-9;]*m//g' | grep -E 'ERROR|WARN|失败|重连|退出' | tail -30"))
    safe_print("== host state.json summary")
    safe_print(run(cli, f"cd {REMOTE_DIR} && node -e \"const d=require('/home/dan/bscagentmint/data/state.json');console.log('cursor='+d.cursor,'day='+d.day,'mintedToday='+d.mintedToday,'attempts='+Object.keys(d.attempts).length); const ks=Object.entries(d.attempts).sort((a,b)=>a[1].at<b[1].at?-1:1).slice(-5); ks.forEach(([k,v])=>console.log(v.at,v.status,k))\" 2>&1 || tail -c 600 data/state.json"))


def resignin(cli):
    """强制重签：先登出（清掉会话文件），再走扫码流程。登出到扫码完成之间服务只通知不打。"""
    run(cli, "docker rm -f baw-signin 2>/dev/null; true")
    out = run(cli, f"cd {REMOTE_DIR} && docker compose run --rm bscagentmint node /app/node_modules/@binance/agentic-wallet/dist/index.js auth signout --json 2>&1 | tail -1")
    safe_print("signout: " + out.strip()[:200])
    signin(cli)


def logs429(cli):
    out = run(cli, f"grep -n '429' {REMOTE_DIR}/logs/app.log | tail -80")
    lines = [l for l in out.splitlines() if l.strip()]
    safe_print(f"429 相关日志行数（最近80条显示）: {len(lines)}")
    if lines:
        safe_print(f"第一条: {lines[0]}")
        safe_print(f"最后一条: {lines[-1]}")
        safe_print("== 原始片段 ==")
        for l in lines[:40]:
            safe_print(l)
    # 容器 stdout 侧带 docker 时间戳的对照
    safe_print("== docker logs (timestamps) ==")
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose logs --timestamps 2>&1 | grep -i '429' | tail -30"))


def runfile(cli, local_path):
    sftp = cli.open_sftp()
    name = os.path.basename(local_path)
    # 传到可写的家目录，运行时以单文件卷挂进容器 /app/data/（data 目录本身 root 属主不可写）
    sftp.put(local_path, f"{REMOTE_DIR}/{name}")
    sftp.close()
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose run --rm -v {REMOTE_DIR}/{name}:/app/data/{name}:ro bscagentmint node data/{name} 2>&1 | sed 's/\\x1b\\[[0-9;]*m//g' | tail -40", timeout=180))


def restartsvc(cli):
    safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose restart"))


ACTIONS = {
    "probe": probe, "push": push, "up": up, "signin": signin, "status": status,
    "net": net, "dnsdiag": dnsdiag, "proxdiag": proxdiag, "bapitest": bapitest,
}

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "probe"
    cli = connect()
    try:
        if action == "setenv":
            setenv_var(cli, sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
        elif action == "getenv":
            getenv_var(cli, sys.argv[2].split(","))
        elif action == "bawstatus":
            bawstatus(cli)
        elif action == "testtg":
            testtg(cli)
        elif action == "address":
            address(cli)
        elif action == "fails":
            fails(cli)
        elif action == "diag":
            diag(cli)
        elif action == "resignin":
            resignin(cli)
        elif action == "logs429":
            logs429(cli)
        elif action == "runfile":
            runfile(cli, sys.argv[2])
        elif action == "restartsvc":
            restartsvc(cli)
        elif action == "restart":
            safe_print(run(cli, f"cd {REMOTE_DIR} && docker compose up -d --build"))
        else:
            ACTIONS[action](cli)
    finally:
        cli.close()
