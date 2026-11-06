# ممیزی فنی: Event-driven I/O و استخر پهنای باند

این سند نتیجهٔ بررسی کد است، نه ادعای marketing. هر جمله با نام فایل و شمارهٔ خط
قابل ردیابی است.

مرجع دو لایهٔ بررسی‌شده:

| لایه | منبع |
|---|---|
| هستهٔ پروکسی (C) | `TelegramMessenger/MTProxy` @ `69f2f083b57bbd94932cb9f4f32155f33e719ff1` (2026-10-22) — همان چیزی که `install.sh:75-91` کلون و بیلد می‌کند |
| لایهٔ مدیریت (TS/bash) | همین ریپازیتوری — `deploy/mtpanel-helper`, `src/lib/*` |

---

# بخش ۱ — Event-driven I/O و epoll

## ۱.۱ خلاصهٔ اجرایی

| پرسش | پاسخ |
|---|---|
| چه سازوکاری؟ | **فقط epoll** (لبه‌ای/`EPOLLET`، با بازگشت به سطحی در شرایط فشار) |
| `poll` یا `select`؟ | **نه** در مسیر داده. تنها یک `select()` در کل کدبیس هست و آن هم یک بررسی یک‌بارهٔ TLS در زمان استارت است، نه بخشی از حلقه |
| حلقه منتظر رویداد می‌ماند یا اتصال‌ها را مرتب بررسی می‌کند؟ | **نه کامل.** فراخوانی `epoll_wait` با تایم‌اوتِ **همیشه ۱ میلی‌ثانیه** است (پارامتر `timeout` در کد **مرده** است). نتیجه: تا ۱۰۰۰ بیدارشدن در ثانیه به‌ازای هر worker، حتی در بیکاری کامل. روی اتصال‌ها busy-poll نمی‌کند، ولی منتظر ماندنِ بلندمدت هم ندارد. §۱.۳ |

## ۱.۲ مکانیزم: epoll خالص

- `net/net-events.c:59` → `int epoll_fd;` — یک نمونهٔ epoll به‌ازای هر **process**.
- `net/net-events.c:78` → `epoll_create (MAX_EVENTS)` تنها نقطهٔ ساخت.
- `net/net-events.c:259-284` → `EPOLL_CTL_ADD / MOD / DEL`.
- `net/net-events.c:373` → `epoll_wait (epoll_fd, new_ev_list, MAX_EVENTS, timeout)`.
- `engine/engine.c:456` → حلقهٔ اصلی: `epoll_work(...)`، که در `net/net-events.c:414`
  به `epoll_fetch_events(1)` می‌رسد.

`MAX_EVENTS = 1 << 19 = 524288` (`net/net-events.h:33`). ساختار `event_t` روی x86-64
دقیقاً ۶۴ بایت است (تأییدشده با کامپایل: `sizeof(event_t)==64`)، پس آرایهٔ ایستای
`Events[]` در `net/net-events.c:57` به‌تنهایی **۳۲ مگابایت RSS** است و هرم رویدادها
(`ev_heap`, `net/net-events.c:62`) ۴ مگابایت دیگر. یعنی هر worker حداقل ~۳۶ MB
حافظه فقط برای زیرساخت رویداد رزرو می‌کند، مستقل از تعداد اتصال.

### `poll`/`select`؟
```
grep -rn "\bpoll (\|select (" --include="*.c"   →  فقط net/net-tcp-rpc-ext-server.c:677
```
آن یک `select()` است داخل بررسی اعتبار دامنهٔ Fake‑TLS (چند سوکت، حداکثر `TRIES` بار،
یک‌بار در استارت). هیچ `poll()` در کد نیست و `select()` هرگز در مسیر داده نیست.

## ۱.۳ تایم‌اوت `epoll_wait` عملاً **همیشه ۱ میلی‌ثانیه** است (یافتهٔ اصلی)

این مهم‌ترین یافتهٔ بخش ۱ است و برخلاف ظاهر کد است.

`engine/engine.c:456` حلقهٔ اصلی:
```c
epoll_work (engine_check_multithread_enabled () ? E->epoll_wait_timeout : 1);
```
طبیعی است فکر کنیم با `--multithread` مقدار `E->epoll_wait_timeout` (پیش‌فرض ۳۷)
استفاده می‌شود. **اما این‌طور نیست:**

```c
int epoll_work (int timeout) {      // net/net-events.c:398
  ...
    epoll_fetch_events (1);          // ← net/net-events.c:414  (literal 1)
  ...
}
```
پارامتر `timeout` در **کل بدنهٔ `epoll_work` هیچ‌جا استفاده نمی‌شود** — نه در
`epoll_runqueue`، نه در `epoll_run_timers`، نه در `jobs_check_all_timers`.
تنها مصرف‌کنندهٔ آن `epoll_fetch_events` است و آن هم با عدد ثابت `1`
صدا زده می‌شود. تأیید: `grep -n "timeout" ` روی خطوط ۳۹۸–۴۴۰ فقط تعریف
پارامتر و یک متغیر محلی نامرتبط (`timeout2`) را برمی‌گرداند.

زنجیرهٔ کامل:
- `engine/engine.c:171` → `assert (1 <= epoll_wait_timeout && ... <= 1000)`
  سقف را روی **۱۰۰۰ms** می‌گذارد.
- `engine/engine.c:548` → `if (!F->epoll_timeout) { F->epoll_timeout = 1; }`
- `mtproto/mtproto-proxy.c:2439` → `.epoll_timeout = 1`

هر سه مسیر (مسیر ۱ms و مسیر ۳۷ms) در نهایت به **همان ۱ میلی‌ثانیه** می‌رسند،
چون مقدار `epoll_wait_timeout` دور ریخته می‌شود.

### پیامد عددی

```
epoll_wait(fd, evlist, 524288, 1)   // هر تکرار حلقه، همیشه
```

- هر worker حداکثر **~۱۰۰۰ بیدارشدن + turnaround در ثانیه** دارد، **حتی با صفر
  اتصال**. این یک busy-ish loop با دورهٔ ۱ms است.
- `epoll_wait` با تایم‌اوت ۱ms روی یک epoll خالی، در عمل یک `nanosleep` کرنلی
  است؛ هزینه‌اش ~۲–۵٬۰۰۰ ns syscall + context switch به‌ازای هر تکرار. یعنی
  حدود **۰.۵–۵٪ یک هسته به‌ازای هر worker** فقط برای نگه‌داشتن حلقه زنده.
- با ۱۰ worker بیکار، یک هستهٔ کامل می‌تواند صرف همین شود. این مستقیماً با
  یافتهٔ §۱.۲ (۳۶ MB حافظهٔ ثابت به‌ازای هر worker) جمع می‌شود.
- چون `select()` نبودن مهم است: **این busy-poll روی «اتصال‌ها» نیست**. هیچ اسکنی
  روی fdها انجام نمی‌شود؛ فقط `epoll_wait` مکرر روی مجموعهٔ خالی/کوچک. تفاوت
  مهم است: هزینه با تعداد اتصال **رشد نمی‌کند**، با تعداد **worker** رشد می‌کند.

### هیچ تنظیمی برای اصلاح وجود ندارد

`--multithread` که `epoll_sleep_ns = 10000` (net-events.c:363, engine.c:661) را
ست می‌کند هم **بدتر** می‌کند: آن یک `nanosleep(10µs)` **قبل از** هر
`epoll_wait` اضافه می‌کند (`net/net-events.c:369-371`)، یعنی تأخیر اضافی بدون
کاهش تعداد wakeup (چون تایم‌اوت همچنان ۱ms است). تنها راه، **patch کردن
upstream** است:

```c
// net/net-events.c:414
epoll_fetch_events (timeout);   // به‌جای 1
```
و سپس ست‌کردن `.epoll_timeout = 37` (یا بیشتر) در `mtproto-proxy.c:2439`.
این تغییر یک‌خطی، بدون ریسک رفتاری، هزینهٔ بیکاری را ~۳۷ برابر کم می‌کند.
تا وقتی این patch نشده، `install.sh` باید بداند که دارد یک binary با حلقهٔ
۱ms بیلد می‌کند.

### مدل threading

- `engine/engine.h:67` → `#define ENGINE_DEFAULT_ENABLED_MODULES (ENGINE_ENABLE_TCP)`
  — یعنی `ENGINE_ENABLE_MULTITHREAD` (`0x1000000`) **روشن نیست**.
- `deploy/run-worker.sh` هیچ‌گاه `--multithread` (یا `-M`) پاس نمی‌دهد.

نتیجه: **هر worker یک پروسهٔ تک‌رشته‌ای جداست**، هیچ CPU موازی‌سازی بین هسته‌ها
ندارد. برای استفاده از چند هسته باید چند worker روی چند پورت ساخت — که این
پلتفرم همین کار را می‌کند و در این طراحی درست است. `-M/--slaves` در دسترس است
ولی `run-worker.sh` آن را پاس نمی‌دهد و خود آپ‌استریم برای TLS توصیه نمی‌کند
(`mtproto-proxy.c:2354-2355`).

## ۱.۴ الگوی epoll: لبه‌ای با fallback سطحی

`net/net-events.c:200-224` (`epoll_conv_flags`):

```c
if (!(flags & EVT_LEVEL)) r |= EPOLLET;   // پیش‌فرض: edge-triggered
```

و `net/net-connections.c:70` → `#define USE_EPOLLET 1`.

`compute_conn_events()` (`net/net-connections.c:276-299`) به‌صورت دینامیک
`EPOLLIN/EPOLLOUT/EPOLLRDHUP/EPOLLPRI` را اضافه می‌کند و **`EVT_LEVEL` را فقط وقتی
که بافر طرف مقابل پر شده (`C_NORD`/`C_NOWR`) اضافه می‌کند** — یعنی طراحی
«edge-triggered به‌صورت پیش‌فرض، level-triggered به‌عنوان ترمز فشار». این الگوی
درست و کلاسیک nginx-style است.

نکتهٔ مهم: چون **اکسپت و خواندن هر دو در حلقهٔ drain هستند**، starvation رخ نمی‌دهد:

- `net_accept_new_connections` (`net/net-connections.c:1267-1332`) تا `EAGAIN` در
  `accept()` می‌چرخد.
- `epoll_runqueue` (`net/net-events.c:~300-355`) تا خالی‌شدن heap می‌چرخد.
- محدودیت‌گذاری صریح هم وجود دارد: `max_accept_rate` (token bucket،
  `net/net-connections.c:75, 212, 1296-1307`) که `run-worker.sh` تنظیمش نمی‌کند.

## ۱.۵ پردازش در حلقه: چه چیزی *اسکن* می‌شود؟

سه چیز در هر تکرار **اسکن** می‌شوند (نه اسکن اتصال‌ها، بلکه اسکن‌های کوچک و کراندار):

| اسکن | محل | هزینه |
|---|---|---|
| `jobs_check_all_timers()` روی همهٔ threadها | `jobs/jobs.c:1286-1293` | O(تعداد thread) ≈ ۱ در حالت single-thread |
| `ev_heap` (رویدادهای آماده) | `net/net-events.c` `epoll_runqueue` | O(رویدادهای آماده) |
| `check_all_conn_buffers()` در cron هر ۱ ثانیه | `mtproto/mtproto-proxy.c:1947-1971` | فقط وقتی استخر بافر به ۳/۴ سقف برسد، از LRU حذف می‌کند |

هیچ حلقه‌ای روی `Events[0..524287]` یا روی لیست کامل اتصال‌ها وجود ندارد. این
**به‌درستی event-driven** است.

## ۱.۶ آیا حلقه واقعاً «منتظر» می‌ماند؟ نه

پاسخ صریح: **به‌طور کامل نه.** حلقه هرگز برای مدت meaningful بلوکه نمی‌شود.

1. **تایم‌اوت ۱ms همیشه** (§۱.۳): `epoll_wait` حداکثر ۱ms بلوکه می‌شود، بعد
   برمی‌گردد، timerها و jobها را اجرا می‌کند و دوباره. حتی در حالت
   `--multithread` هم همین است، چون پارامتر `timeout` مرده است.
2. **`nanosleep` اضافی** (`net/net-events.c:369-371`) فقط با `--multithread`
   فعال می‌شود (۱۰µs) و صرفاً تأخیر را بیشتر می‌کند.

پس دسته‌بندی دقیق این است:

| ویژگی | وضعیت |
|---|---|
| busy-poll روی fdهای اتصال (`select`/`poll` روی همه) | ❌ وجود ندارد |
| اسکن دوره‌ای اتصال‌ها | ❌ وجود ندارد |
| `epoll_wait` با تایم‌اوت بلند | ❌ هرگز (همیشه ۱ms) |
| بیدارشدن مکرر با epoll خالی | ✅ دارد — تا ۱۰۰۰/s به‌ازای هر worker |

یعنی: **رویدادمحور در مکانیزم، ولی بی‌قرار در زمان‌بندی**. این تفاوت ظریف
مهم است — کسی که فقط `epoll` را در کد ببیند نتیجه می‌گیرد حلقه کاملاً
blocking و بی‌هزینه است، در حالی که نیست.

## ۱.۷ چیزی که پنل به‌عنوان «EPOLL check» انجام می‌دهد

`deploy/mtpanel-helper:403-413` (`cmd_epoll`) تعداد fdهای
`anon_inode:[eventpoll]` را در `/proc/<pid>/fd` می‌شمارد.
`src/lib/workers.ts:246-256` آن را به `active (n eventpoll fd)` تبدیل می‌کند.

ارزیابی: این چک **درست است ولی ارزش تشخیصی کمی دارد**. MTProxy همیشه epoll دارد
(کامپایل‌شده است)، پس این عدد عملاً همیشه ≥ ۱ است. `epollSupported()` در
`src/lib/system/metrics.ts:113-115` هم فقط وجود
`/proc/sys/fs/epoll/max_user_watches` را چک می‌کند که روی هر کرنل لینوکسی هست.
این «بررسی» توانایی تشخیص misconfiguration ندارد — چون **هیچ تنظیمی برای epoll
وجود ندارد**. README (`خط ۶۹`) این را صادقانه می‌گوید؛ فقط باید انتظار را پایین
نگه داشت.

## ۱.۸ یافته‌های جانبی مؤثر بر I/O

- `window_clamp` (`mtproto/mtproto-proxy.c:98` → `DEFAULT_WINDOW_CLAMP 131072`):
  در **حالت غیر‑TLS** (`domain_count == 0`) به‌طور خودکار روی همهٔ سوکت‌ها
  `TCP_WINDOW_CLAMP=128KiB` ست می‌شود (`mtproto-proxy.c:2166-2184`,
  `net-connections.c:756-766`). این عمداً پنجرهٔ TCP را کوچک نگه می‌دارد و
  **سقف عملی throughput به ازای هر اتصال** را با RTT تعیین می‌کند:
  `BDP ≈ 128KiB / RTT`. برای RTT=۱۰۰ms یعنی ~۱۰ Mbit/s به‌ازای هر اتصال.
  در حالت Fake‑TLS (`-D`) این clamp اعمال نمی‌شود.
- `maximize_sndbuf`/`maximize_rcvbuf` (`net/net-events.c:482-553`) با جست‌وجوی
  دودویی، بافر سوکت را تا سقف کرنل بزرگ می‌کنند — **فقط در حالت غیر‑TLS**
  (`tcp_maximize_buffers` در `mtproto-proxy.c:2166`). اگر
  `net.core.rmem_max/wmem_max` را بالا نبرید، این «maximize» عملاً بی‌اثر است.
  `install.sh` **هیچ sysctl شبکه‌ای ست نمی‌کند** — تنها `kernel.pid_max`
  (`install.sh:93-97`). این یک شکاف tuning است.
- سقف سخت اتصال در پروکسی: `MAX_CONNECTIONS = 65536` و
  `cfd >= max_connection_fd` ⇒ `accept_connection_limit_failed`
  (`net/net-connections.c:78-80, 622-628`). یعنی حتی اگر `LimitNOFILE=1048576`
  باشد، پروکسی بالای ۶۵٬۵۳۵ اتصال را رد می‌کند. `-C` (که پلتفرم پاس می‌دهد)
  سقف *کاربر* است، نه سقف fd؛ و اکسپت را متوقف نمی‌کند — فقط listener را از
  epoll خارج می‌کند و پیام `ERROR: forced to accept connection...` می‌دهد
  (`net-connections.c:743-755`).
- `backlog` پیش‌فرض ۸۱۹۲ (`common/server-functions.h:120`). اگر
  `net.core.somaxconn` کمتر باشد، کرنل آن را به سقف خودش می‌بُرد.

---

# بخش ۲ — «استخر مشترک پهنای باند»

## ۲.۰ پاسخ صریح به سه پرسش

| پرسش | پاسخ |
|---|---|
| محدودیت فعلی در سطح Worker است یا هر اتصال؟ | **سطح Worker** (به‌ازای هر پورت). در سطح هر اتصال: **هیچ**. |
| دانلود و آپلود جدا اعمال می‌شوند؟ | **بله** — egress (دانلود) و ingress (آپلود) دو مسیر جدا با دو کلاس HTB جدا. |
| برای اتصال‌های غیرفعال منبع رزرو می‌شود؟ | در لایهٔ shaping **خیر** (HTB بر اساس ترافیک کار می‌کند، نه بر اساس شمارش اتصال). اما در لایهٔ پروکسی **بله** — به‌طور غیرمستقیم و قابل‌توجه (§۲.۵). |

**«استخر مشترک» (shared pool) به آن معنا که در درخواست آمده، در این کدبیس وجود
ندارد.** هیچ مفهومی از مجموع پهنای باند کل سرور که بین workerها تقسیم شود، یا
سهمیهٔ مشترک، در schema یا helper نیست:

```
grep -rn -i "pool|shared|aggregate" src/lib deploy  →  فقط pg pool و ssl_session_cache
```

هر worker سقف مستقل خودش را دارد. این یعنی N worker با سقف ۱۰۰ Mbit/s می‌توانند
جمعاً N×۱۰۰ Mbit/s بکشند و مجموع **هیچ سقفی ندارد**.

## ۲.۱ لایهٔ shaping: tc HTB + ifb

همه‌چیز در `deploy/mtpanel-helper:58-145`:

```
ensure_tc_base()      # qdisc htb 1: root + class 1:1 (100gbit) + default 9999
                      # qdisc ingress ffff: روی IF اصلی
                      # ifb0 + htb 1: روی ifb0
tc_apply_worker()     # کلاس 1:<id+16> + filter بر اساس پورت
```

- **دانلود (client ← proxy) = egress**: کلاس روی `$IF` با
  `htb rate ${down}kbit ceil ${down}kbit` و فیلتر
  `u32 match ip sport <port>` (خط ۱۲۹-۱۳۲). `ceil == rate` ⇒ سخت‌گیرانه، بدون
  burst به سقف بالاتر.
- **آپلود (client → proxy) = ingress**: فیلتر `parent ffff:` روی `$IF` با
  `match ip dport <port>` + `action mirred egress redirect dev ifb0`، و سپس کلاس
  `htb rate ${up}kbit` روی `ifb0` (خط ۱۳۳-۱۴۰).
- IPv4 و IPv6 **جدا** فیلتر می‌شوند (`protocol ip` prio `id+10` و
  `protocol ipv6` prio `id+32000`) و وضعیت هر کدام مستقل گزارش می‌شود
  (`tc_v4`, `tc_v6`, `ifb_v4`, `ifb_v6`).
- `DOWN=0` یا `UP=0` ⇒ `rd="100gbit"` یعنی کلاس «بی‌نهایت» (خط ۱۲۰-۱۲۲). این
  طراحی خوبی است: کلاس همیشه وجود دارد تا **حسابداری/نمونه‌گیری** همیشه ممکن باشد
  (`cmd_stats`, خط ۳۵۰-۳۵۴).

### ارزیابی درستی

- **سطح Worker: تأییدشده.** فیلتر فقط روی پورت همان worker است، پس SSH، پنل و
  workerهای دیگر تحت تأثیر نیستند. این ادعای README (`خط ۶۷`) درست است.
- **سطح هر اتصال: وجود ندارد.** فیلتر `u32` روی `sport`/`dport` است و هیچ
  `flowid`/`hash` بر اساس ۵‑tuple وجود ندارد. پس **یک اتصال تنها می‌تواند کل
  سهم worker را مصرف کند**. اگر هدف «عدالت بین کاربران» است، این پیاده‌سازی
  آن را نمی‌دهد.
- **اتصال‌های غیرفعال منبع رزرو می‌کنند؟ در این لایه نه.** HTB یک
  class-full scheduler با token bucket است؛ اتصالی که ترافیک ندارد هیچ توکنی مصرف
  نمی‌کند و سهمیهٔ دیگران را آزاد می‌گذارد. `ceil == rate` هم یعنی burst مشترک
  بین اتصال‌ها وجود ندارد که بیکار بماند.
  **نکتهٔ ظریف:** `fq_codel` روی هر کلاس (`خط ۱۳۰`, `۱۳۶`) صف را بر اساس flow
  (hash پنج‌گانه) جدا می‌کند؛ پس *درون* یک worker، اتصال‌های فعال به‌طور
  fair-ish بین خودشان تقسیم می‌شوند. یعنی per-connection fairness به‌طور
  **غیرمستقیم و تقریبی** از `fq_codel` می‌آید، نه از HTB. این را باید درست فهمید:
  HTB سقف worker را می‌دهد، fq_codel عدالت بین flowها را (بدون هیچ تضمین عددی).

## ۲.۲ باگ‌ها و ریسک‌های واقعی در لایهٔ shaping

### (الف) فیلترهای tc تجمعی هستند؛ `net_apply` آن‌ها را پاک نمی‌کند 🔴

`tc_clear_worker()` (خط ۹۸-۱۱۱) **هیچ‌جا در `net_apply()` صدا زده نمی‌شود**.
تنها دو محل فراخوانی در کل فایل (`grep`):
- خط ۳۱۶ → فقط وقتی **پورت عوض شده** باشد.
- خط ۳۹۰ → فقط هنگام حذف worker.

در مقابل، `tc filter add` (خطوط ۱۳۱, ۱۳۲, ۱۳۵, ۱۳۸, ۱۳۹, ۱۴۰) هر بار یک فیلتر
**جدید** اضافه می‌کند. `tc class replace` (خط ۱۲۹, ۱۳۶) ایدیومپوتنت است، ولی
`add` نیست. توجه کنید که پلتفرم برای nft عمداً `nft_global_delete` را **قبل** از
`add` صدا می‌زند (خط ۱۷۵، با کامنت خط ۱۵۰: «Reapplying deletes the old rule
first … so rules are never duplicated»). **همین انضباط برای tc اعمال نشده.**

#### مسیرهای بازفراخوانی

برای **همان worker با همان پورت**:
`src/lib/workers.ts:301, 330, 358` (هر deploy / start / restart)،
`src/lib/protection.ts:230` (هر تغییر stage حفاظت)،
`src/lib/runtime.ts:55` (job `worker.net`)، و `cmd_restore_all`
(`mtpanel-helper:326-348`) در هر بوت.

#### دو پیامد ممکن

1. **اگر `tc` افزودن را بپذیرد:** N فیلتر با prio یکسان به یک `flowid` می‌رسند.
   عملکرد معمولاً درست می‌ماند (همه به یک کلاس اشاره می‌کنند)، اما
   - لیست فیلتر با هر restart/protection-tick رشد می‌کند؛
   - در `cls_u32` جست‌وجو در هر زنجیرهٔ هم‌اولویت **خطی** است، پس مسیر hot-path
     کلاس‌بندی به تعداد فیلتر وابسته می‌شود.
2. **اگر کرنل `RTNETLINK answers: File exists` بدهد:** با
   `2>/dev/null` خطا پنهان می‌شود و شاخهٔ `||` اجرا می‌شود ⇒ `TC_V4=failed`
   **بدون اینکه shaping واقعاً خراب شده باشد**. سپس `net-apply` با exit 3
   برمی‌گردد و `applyNetRules` در `src/lib/workers.ts:190-193` **exception
   پرتاب می‌کند**. یعنی دقیقاً برعکس قاعدهٔ ARCHITECTURE §۴: **کار می‌کند، ولی
   «اعمال نشد» گزارش می‌شود.** این همان چیزی است که اعتماد به پنل را از بین
   می‌برد.

#### اصلاح پیشنهادی — با یک تلهٔ مهم

ساده‌ترین رفع، فراخوانی `tc_clear_worker` در ابتدای `tc_apply_worker` است. **ولی
این اشتباه است:** `tc_clear_worker` علاوه بر فیلترها
`tc class del dev … classid 1:<cls>` را هم می‌زند (خط ۱۰۴). حذف کلاس
**شمارندهٔ `tc -s` را ریست می‌کند**، و `src/lib/monitor.ts:139-146` آن را
«counter reset» تفسیر کرده و delta را از صفر حساب می‌کند ⇒ یک جهش/افت نادرست
در نمودار ترافیک در هر restart.

پس اصلاح درست، فقط پاک‌کردن **فیلترها** و نگه‌داشتن کلاس است:

```bash
# در ابتدای tc_apply_worker، بعد از محاسبهٔ p4/p6/cls — «فقط فیلتر»:
tc filter del dev "$IF"       parent 1:    prio "$p4" 2>/dev/null || true
tc filter del dev "$IF"       parent ffff: prio "$p4" 2>/dev/null || true
tc filter del dev "$IF"       parent 1:    prio "$p6" 2>/dev/null || true
tc filter del dev "$IF"       parent ffff: prio "$p6" 2>/dev/null || true
tc filter del dev ifb0        parent 1:    prio "$p4" 2>/dev/null || true
tc filter del dev ifb0        parent 1:    prio "$p6" 2>/dev/null || true
# کلاس‌ها با tc class replace (خط ۱۲۹/۱۳۶) به‌روز می‌شوند و شمارنده‌شان حفظ می‌شود
```

این هم ایدیومپوتنت است، هم شمارندهٔ ترافیک را حفظ می‌کند، هم `prio` یکتا
به‌ازای هر worker (`id+10` برای v4، `id+32000` برای v6) را تضمین می‌کند.

### (ب) `ensure_tc_base` خطاهای ifb را می‌بلعد 🟠

خطوط ۸۲-۸۹: `ip link add ifb0 ... || return 0`، `tc qdisc replace dev ifb0 ... ||
return 0`. اگر ساخت ifb0 شکست بخورد، تابع با **موفقیت** برمی‌گردد در حالی که
`IFB_OK=0` است. بعداً خط ۱۴۱-۱۴۲ `IFB_V4=failed` می‌گذارد — پس صادق است، ولی
خطا هرگز لاگ نمی‌شود و کسی نمی‌فهمد *چرا*. برای یک helper روت که روی VPS کار
می‌کند این ریسک پذیرفتنی است (fail-open برای upload)، اما در عیب‌یابی کور است.

### (ج) `ensure_tc_base` روی هر بار اجرا `modprobe` می‌زند 🟡

خط ۸۰: `modprobe ifb numifbs=1` بدون هیچ کش. `modprobe` روی ماژول بارگذاری‌شده
سریع است ولی هنوز fork/exec است. چون `net_apply` مکرر صدا زده می‌شود، قابل
بهینه‌سازی است (`[[ -d /sys/module/ifb ]] || modprobe ...`).

### (د) تصحیح یک ادعای مستندات 🟡

README `خط ۶۶`: «The concurrent-connection limit is **enforced** with iptables
`connlimit`». این منسوخ است. مسیر اصلی **nftables در خانوادهٔ `inet`** است
(`mtpanel-helper:154-188`) و `iptables connlimit` فقط fallback است
(`خط ۲۶۶-۲۷۳`) که به‌صراحت `nft_global=fallback-iptables-per-family` برچسب
می‌خورد و exit 3 می‌دهد. خود ARCHITECTURE §۳ درست توضیح داده. README باید
هم‌راستا شود، وگرنه کسی که فقط README را بخواند فکر می‌کند یک شمارندهٔ مشترک
v4+v6 همیشه هست.

### (ه) `ufw_sync` در `cmd_remove` پورت اشتباه را باز نگه می‌دارد 🟡

`cmd_remove` (خط ۳۹۲) `ufw_sync "$id" "$oldport" ""` صدا می‌زند؛ این رویهٔ درست
است. اما `ufw_sync` (`خط ۲۳۸-۲۴۵`) با `ufw --force delete allow "$old/tcp"`
**همهٔ** قواعد `old/tcp` را حذف می‌کند، نه فقط آن‌هایی که کامنت
`mtpanel-worker-<id>` دارند. اگر ادمین به‌صورت دستی همان پورت را باز کرده باشد
یا دو worker (که schema مانعش می‌شود) — کم‌ریسک، ولی حذف کور است.

### (و) اگر `ufw` فعال نباشد، پورت worker باز نمی‌شود 🟡

`ufw_sync` خط ۲۴۱: `ufw status | grep -q '^Status: active' || return 0`. با
`--no-firewall` (install.sh:35) هیچ قاعده‌ای اضافه نمی‌شود. روی سروری که
ورودی را با قاعدهٔ default-deny می‌بندد، worker «active» می‌شود ولی از بیرون
دسترسی ندارد، و no metric ای این را نمی‌گیرد چون `tcpProbe` روی `127.0.0.1` است
(`src/lib/runtime.ts:88`).

## ۲.۳ «اتصال‌های غیرفعال» — چه چیزی واقعاً رزرو می‌شود؟

سه منبع مختلف را باید جدا کرد:

### ۱) در لایهٔ shaping (tc/HTB): **رزرو صفر**
HTB کلاس را با `rate` می‌سازد ولی توکن فقط با بایت مصرف می‌شود. ۱۰۰۰ اتصال idle
هیچ بایتی از سهمیه نمی‌خورند. `fq_codel` هم صف‌های خالی را هزینه‌ای نمی‌دهد.

### ۲) در لایهٔ پروکسی: **رزرو حافظهٔ ثابت و بزرگ**
- `Events[MAX_EVENTS]` = **۳۲ MB** + `ev_heap` = **۴ MB** در *هر* worker، مستقل
  از تعداد اتصال (`net/net-events.c:57-63`).
- هر اتصال ۴ ساختار `rwm` (in/out/in_u/out_p) + یک `socket_connection_job` +
  یک `job_timer` می‌گیرد (`net/net-connections.c:648-656, 1223-1258`) — این
  **رزرو per-connection** است، ولی از استخر بافر مشترک
  (`MSG_BUFFERS_CHUNK_SIZE = 2 MiB − 64`, `net/net-msg-buffers.h:34`) تغذیه
  می‌شود که سقف پیش‌فرضش `MSG_DEFAULT_MAX_ALLOCATED_BYTES = 1 << 28` = **۲۵۶ MB**
  است (`net/net-msg-buffers.h:36`). این استخر **مشترک بین همهٔ اتصال‌های یک
  process** است و وقتی به ۳/۴ برسد، `check_all_conn_buffers` از LRU قدیمی‌ترین
  اتصال‌ها را می‌بندد (`mtproto-proxy.c:1947-1971`). **این نزدیک‌ترین چیزی است
  به «استخر مشترک» در کل سیستم — و مهم است که با shaping اشتباه گرفته نشود:
  استخر بافر است، نه پهنای باند.**
- `-W/--window-clamp` (پیش‌فرض ۱۲۸ KiB در حالت غیر‑TLS): این **رزرو per-connection
  در کرنل** است (`TCP_WINDOW_CLAMP`). یعنی هر اتصال می‌تواند تا ۱۲۸ KiB بافر
  receive کرنل نگه دارد. با ۶۵k اتصال، تئوریک تا ۸ GiB. در عمل
  `net.core.rmem_max` سقف را تعیین می‌کند — و install.sh آن را ست نمی‌کند.

### ۳) در لایهٔ شمارش اتصال: **رزرو با محدودیت، ولی نشت در مسیر خطا**
`max_special_connections` (از `-C`) با `SM_SPECIAL` شمارندهٔ اتمیک
`active_special_connections` را زیاد/کم می‌کند
(`net/net-connections.c:519-537` و `743-755`). وقتی به سقف برسد، **listener از
epoll حذف می‌شود** (نه اینکه SYN رد شود) — یعنی اتصال‌های جدید در backlog کرنل
معطل می‌مانند تا یکی آزاد شود. رفتار درستی است، ولی باید بدانید که «سقف اتصال»
یعنی **صف‌شدن در backlog**، نه `RST`.

**نکتهٔ منفی:** nftables/iptables هر دو `ct state new`/`--syn` را می‌شمارند که
SYNهای نیمه‌باز (handshake ناتمام) را هم شامل می‌شود، و **هیچ timeout اختصاصی
ای برای این شمارنده‌ها ست نمی‌شود**. یک nft جدول `inet mtpanel` هم
`ct count over ... drop` می‌زند، اما `ct` state machine جدول conntrack مستقل
دارد؛ اگر `nf_conntrack_tcp_timeout_syn_recv` بالا باشد، SYN‑flood کوچک
می‌تواند سهمیهٔ worker را برای همه مسدود کند (این حمله به خود پروکسی هم هست،
ولی محدودیت nft سطح حمله را از «پروکسی را کند کن» به «همه را قطع کن» تغییر
می‌دهد). mitigations موجود: `deploy/systemd/mtpanel-netrules.service` فقط
restore می‌کند، هیچ sysctl‑ی برای conntrack نیست.

## ۲.۴ مسیر داده: چرا shaping *واقعاً* دو طرفه است (و کجا نیست)

ARCHITECTURE §۴ می‌گوید «Bandwidth limits apply to client-side traffic … Shaping
the client side throttles both directions in practice». این را باید دقیق خواند:

- **دانلود** (`proxy → client`): بایت‌ها روی سوکت client **فرستاده** می‌شوند ⇒
  از egress `$IF` با `sport = port` عبور می‌کنند ⇒ **HTB واقعاً throttle می‌کند**
  و backpressure از طریق flow control تویی TCP به DC منتقل می‌شود. ✅
- **آپلود** (`client → proxy`): بایت‌ها روی `$IF` **دریافت** می‌شوند ⇒ به ifb0
  redirect و آنجا throttle می‌شوند. پس از throttle، بسته‌ها به‌سرعت در صف ifb
  می‌مانند؛ چون سوکت proxy به‌اندازهٔ کافی سریع نمی‌خواند، پنجرهٔ TCP کلاینت
  بسته می‌شود. ✅ (اما با یک صف اضافی و ~۱ RTT تأخیر بیشتر.)
- **ترافیک proxy ↔ DC تلگرام**: پورت ephemeral است، فیلتر match نمی‌کند ⇒
  **shape نمی‌شود**. ✅ همان‌طور که مستند شده.

نتیجه: **بله، دانلود و آپلود جداگانه و مستقل اعمال می‌شوند**، و هر کدام می‌تواند
مستقل fail کند و مستقل گزارش شود. این بخش از پیاده‌سازی باکیفیت است.

## ۲.۵ ناسازگاری: محدودیت اتصال *دو* جا اعمال می‌شود

`run-worker.sh:16-17` وقتی `MAXCONN != 0` باشد `-C "$MAXCONN"` را هم پاس می‌دهد،
و `workers.ts:140-142` همان مقدار را در `net-apply` به‌عنوان `TOTAL` می‌فرستد.
یعنی **هم پروکسی (`-C`, شمارندهٔ داخلی) و هم nft (`ct count over N`)** همان سقف
را اعمال می‌کنند.

پیامد: وقتی به سقف برسید، **nft اول SYN را drop می‌کند** و پروکسی هرگز آن را
نمی‌بیند ⇒ شمارندهٔ `-C` هرگز به سقف نمی‌رسد ⇒ مسیر «listener را از epoll خارج
کن» (`net-connections.c:751-755`) عملاً هرگز فعال نمی‌شود. این کار
**کاهش امنیتی/کارایی** است: drop بی‌صدا به‌جای backpressure، و دو منبع حقیقت
که می‌توانند واگرا شوند (مثلاً وقتی `MAXCONN` در پنل عوض شود و `net-apply`
شکست بخورد ولی systemd restart شود). پیشنهاد: یکی را انتخاب کنید. برای
«کاربر باید متصل شود، فقط نه بیشتر از N» → `-C` تنها. برای «محافظت از منابع
سرور» → nft تنها.

## ۲.۶ پنل: چه چیزی را نشان می‌دهد و چه چیزی را نه

- محدودیت‌ها: `downloadKbps` / `uploadKbps` (حداقل ۶۴، حداکثر ۱۰٬۰۰۰٬۰۰۰ kbit/s)
  در `src/app/api/workers/[id]/route.ts:37-38`. اعتبارسنجی خوب است، ولی **هیچ
  کف منطقی بر اساس تعداد اتصال یا ظرفیت لینک نیست** — می‌توانید ۶۴ kbit/s روی
  ۱۰۰۰ کاربر بگذارید و همه را عملاً قطع کنید.
- `TOTAL` = `maxConnections` است، **نه** مجموع پهنای باند. اسم‌گذاری در helper
  گیج‌کننده است (`TOTAL` در `net-apply` یعنی سقف اتصال، در حالی که `DOWN`/`UP`
  یعنی پهنای باند).
- `src/lib/core/netstatus.ts:19-28`: `enforced` تنها وقتی true است که همهٔ
  مؤلفه‌ها `ok`/`off` باشند. منطق **درست** است. ولی `partial` تنها وقتی true
  است که `failed.length < applicable.length` — یعنی اگر **همه** شکست بخورند،
  `partial=false` و `enforced=false` و هیچ‌کدام true نیستند؛ UI باید این حالت
  را «failed» نشان دهد، که با بررسی `net_status` در
  `src/lib/api.ts` انجام می‌شود. باید تست شود که این حالت سوم واقعاً در
  داشبورد دیده می‌شود (نه خالی).
- حفاظت CPU (`src/lib/core/protection-engine.ts:43-49`): `stage2BandwidthFactor:
  0.5` و `stage2MinKbps: 1024`. در `src/lib/protection.ts:125-126`،
  `reducedLimit()` **کف ۱۰۲۴ kbit/s** را تضمین می‌کند. این یعنی اگر یک worker
  با سقف ۵۰۰ kbit/s تنظیم شده باشد و حفاظت فعال شود، سقف به **۱۰۲۴** می‌رود.
  **این با اجرای واقعی تأیید شد:**
  ```
  reducedLimit(500, 0, 0.5, 1024)  →  1024     // سقف بالا رفت!
  reducedLimit(64, 0, 0.5, 1024)   →  1024     // 64 → 1024، ۱۶ برابر بیشتر
  reducedLimit(20000, 0, 0.5, 1024) → 10000    // حالت درست
  ```
  منبع کد: `src/lib/core/protection-engine.ts`, تابع `reducedLimit`. این تابع
  `Math.max(minKbps, ...)` است، **بدون clamp به `currentKbps`**. پس وقتی
  `currentKbps < minKbps`، «محدودسازی» عملاً افزایش سقف می‌شود. اصلاح:
  ```ts
  return Math.min(currentKbps ?? Infinity, Math.max(minKbps, Math.floor(base * factor)));
  ```
  یا کف را نسبت به مقدار فعلی بگیرید، نه مطلق.

## ۲.۷ شکاف‌های observable

- شمارنده‌های `tc class` فقط **بایت** می‌دهند، پس نرخ در
  `src/lib/monitor.ts:134-152` از delta محاسبه می‌شود (۵ ثانیه‌ای) — برای
  دیدن throttle شدن یک اتصال واحد کافی نیست.
- هیچ متریک `dropped`/`backlog`/`SYN retransmit` از `tc -s` یا
  `nstat`/`netstat -s` جمع نمی‌شود. یعنی وقتی shaping فعال است و کاربران
  از «کندی» شکایت دارند، پنل نمی‌تواند بین «سقف عمدی» و «مشکل شبکه» تفکیک کند.
- سقف `ifb0` مشترک بین همهٔ workerهاست: اگر ۱۰ worker آپلود shaping‌شده داشته
  باشند، همه به یک دستگاه `ifb0` می‌ریزند. کلاس‌ها جدا هستند پس سقف‌ها مستقل‌اند،
  ولی **ظرفیت پردازش ifb0 مشترک است** و هیچ متریکی برای صف/افت آن نیست.

---

# بخش ۳ — جمع‌بندی: اولویت اقدام

| # | موضوع | شدت | اقدام |
|---|---|---|---|
| ۱ | `epoll_work` پارامتر `timeout` را دور می‌ریزد ⇒ `epoll_wait` همیشه ۱ms، تا ۱۰۰۰ wakeup/s در بیکاری، ~۰.۵–۵٪ هسته به‌ازای هر worker | 🔴 بالا (هزینهٔ بی‌دلیل) | patch یک‌خطی `epoll_fetch_events(timeout)` |
| ۲ | `tc_clear_worker` قبل از `tc_apply_worker` صدا زده نمی‌شود ⇒ فیلترهای تکراری؛ اگر کرنل `EEXIST` بدهد، shaping کار می‌کند ولی `failed` گزارش می‌شود | 🔴 بالا | یک خط در `mtpanel-helper:118` |
| ۳ | `reducedLimit` کف ۱۰۲۴ kbit/s را حاکم می‌کند ⇒ برای worker با سقف < ۱۰۲۴، «حفاظت» سقف را **بالا می‌برد** | 🟠 متوسط (تأییدشده با اجرا) | clamp به مقدار فعلی |
| ۴ | `-C` و `nft ct count` هم‌زمان ⇒ nft برنده می‌شود، backpressure پروکسی هرگز فعال نمی‌شود | 🟠 متوسط | یکی را انتخاب و مستند کنید |
| ۵ | هیچ sysctl شبکه‌ای (rmem/wmem/somaxconn/conntrack) ست نمی‌شود ⇒ `maximize_*buf` تقریباً بی‌اثر، backlog بریده، SYN-flood سهمیهٔ nft را می‌بلعد | 🟠 متوسط | `/etc/sysctl.d/99-mtpanel.conf` |
| ۶ | README می‌گوید `iptables connlimit`، ولی مسیر اصلی nft است | 🟡 پایین | اصلاح متن |
| ۷ | `ufw_sync` حذف کور قواعد / با `--no-firewall` پورت باز نمی‌شود | 🟡 پایین | فیلتر با کامنت |
| ۸ | «EPOLL check» ارزش تشخیصی صفر دارد (epoll همیشه هست) | 🟡 پایین | انتظار را در UI کم کنید |
| ۹ | `ensure_tc_base` خطاهای ifb را بی‌صدا می‌بلعد و هر بار `modprobe` می‌زند | 🟡 پایین | لاگ + کش |

## چیزی که درست و باکیفیت است (برای انصاف)

- epoll خالص، edge-triggered با level-triggered backpressure — طراحی درست.
- اکسپت و drain تا `EAGAIN` — بدون starvation.
- shaping در دو جهت مستقل (egress برای دانلود، ifb برای آپلود) با وضعیت مستقل
  per-family — بسیار خوب.
- `NETSTATUS` و برچسب‌گذاری صریح fallback به‌جای ادعای موفقیت — بهتر از
  اکثر پروژه‌های مشابه.
- `ceil == rate` در HTB ⇒ بدون burst پنهان از سقف.
- `fq_codel` روی هر کلاس ⇒ عدالت تقریبی بین flowها بدون پیچیدگی.
- **هیچ اسکن دوره‌ای روی اتصال‌ها وجود ندارد** — هزینه با تعداد اتصال رشد نمی‌کند.

## محدودیت این ممیزی (صادقانه)

- کرنل این sandbox ماژول `sch_htb`/`dummy`/`ifb` و پشتیبانی `nft inet` را ندارد،
  پس رفتار «فیلتر تکراری» (§۲.۲‑الف) با `tc` واقعی **تأیید تجربی نشد**. مبنای
  آن: عدم فراخوانی `tc_clear_worker` در `net_apply` است که با `grep` قطعی است؛
  رفتار دقیق کرنل در برابر فیلتر هم‌اولویت بین «پذیرش بی‌اثر» و «EEXIST» است.
  باید روی یک VPS واقعی با `tc filter show dev eth0 parent 1:` بعد از دو بار
  `net-apply` بررسی شود.
- تست `tests/netns-integration.sh` در همین محیط اجرا شد: ۱۱/۱۱ چک پاس شد، ولی
  همهٔ چک‌های واقعی `tc`/`ifb`/`connlimit` به‌دلیل نبود capability در namespace
  به مسیر «گزارش صادقانهٔ محدودیت» رفتند — یعنی خود تست هم اینجا shaping را
  اثبات نکرد.
- مورد ۳ (§۲.۶) با اجرای تابع روی مقادیر واقعی **تأیید شد**:
  `reducedLimit(500, 0, 0.5, 1024) → 1024`.

