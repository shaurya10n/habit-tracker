import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

const STORAGE_KEY = 'habit-tracker-v1'
const STREAK_MILESTONES = [7, 30, 100] as const

const DEFAULT_HABIT_NAMES = [
  'Apply to Jobs',
  'Exercise',
  'Creatine',
  'Supplements',
  'Mobility',
  'Cold Shower',
] as const

type Habit = { id: string; name: string }

type Persisted = {
  version: 2
  habits: Habit[]
  /** YYYY-MM-DD → habitId → completed */
  completions: Record<string, Record<string, true>>
  bestStreakByHabitId: Record<string, number>
  /** habitId → milestone day string "7" | "30" | "100" → shown once */
  milestoneSeen: Record<string, Record<string, true>>
}

function formatYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function defaultHabits(): Habit[] {
  return DEFAULT_HABIT_NAMES.map((name) => ({
    id: crypto.randomUUID(),
    name,
  }))
}

function cloneMilestoneSeen(
  s: Record<string, Record<string, true>>,
): Record<string, Record<string, true>> {
  const out: Record<string, Record<string, true>> = {}
  for (const [id, m] of Object.entries(s)) {
    out[id] = { ...m }
  }
  return out
}

function backfillStreakFields(
  habits: Habit[],
  completions: Persisted['completions'],
): Pick<Persisted, 'bestStreakByHabitId' | 'milestoneSeen'> {
  const bestStreakByHabitId: Record<string, number> = {}
  const milestoneSeen: Record<string, Record<string, true>> = {}
  for (const h of habits) {
    const streak = habitStreak(completions, h.id)
    bestStreakByHabitId[h.id] = streak
    const seen: Record<string, true> = {}
    for (const m of STREAK_MILESTONES) {
      if (streak >= m) seen[String(m)] = true
    }
    if (Object.keys(seen).length > 0) milestoneSeen[h.id] = seen
  }
  return { bestStreakByHabitId, milestoneSeen }
}

function loadPersisted(): Persisted {
  const fresh = (): Persisted => ({
    version: 2,
    habits: defaultHabits(),
    completions: {},
    bestStreakByHabitId: {},
    milestoneSeen: {},
  })

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fresh()

    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object') return fresh()

    const rec = data as Record<string, unknown>
    const habitsRaw = rec.habits
    if (!Array.isArray(habitsRaw)) return fresh()

    const habits = habitsRaw.filter(
      (h): h is Habit =>
        typeof h?.id === 'string' &&
        typeof h?.name === 'string' &&
        h.name.length > 0,
    )
    const completions =
      rec.completions && typeof rec.completions === 'object'
        ? (rec.completions as Persisted['completions'])
        : {}

    if (habits.length === 0) return fresh()

    const ver = rec.version
    if (ver !== 2) {
      const bf = backfillStreakFields(habits, completions)
      return {
        version: 2,
        habits,
        completions,
        bestStreakByHabitId: bf.bestStreakByHabitId,
        milestoneSeen: bf.milestoneSeen,
      }
    }

    let bestStreakByHabitId: Record<string, number> = {}
    if (rec.bestStreakByHabitId && typeof rec.bestStreakByHabitId === 'object') {
      for (const [k, v] of Object.entries(rec.bestStreakByHabitId)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          bestStreakByHabitId[k] = Math.floor(v)
        }
      }
    }

    let milestoneSeen: Record<string, Record<string, true>> = {}
    if (rec.milestoneSeen && typeof rec.milestoneSeen === 'object') {
      for (const [hid, map] of Object.entries(rec.milestoneSeen)) {
        if (!map || typeof map !== 'object') continue
        const inner: Record<string, true> = {}
        for (const [mk, mv] of Object.entries(map)) {
          if (mv === true) inner[mk] = true
        }
        if (Object.keys(inner).length > 0) milestoneSeen[hid] = inner
      }
    }

    for (const h of habits) {
      const streak = habitStreak(completions, h.id)
      const prev = bestStreakByHabitId[h.id] ?? 0
      if (streak > prev) bestStreakByHabitId[h.id] = streak
      for (const m of STREAK_MILESTONES) {
        if (streak >= m) {
          if (!milestoneSeen[h.id]) milestoneSeen[h.id] = {}
          milestoneSeen[h.id][String(m)] = true
        }
      }
    }

    return {
      version: 2,
      habits,
      completions,
      bestStreakByHabitId,
      milestoneSeen,
    }
  } catch {
    return fresh()
  }
}

function savePersisted(p: Persisted) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
}

function isCompleted(
  completions: Persisted['completions'],
  habitId: string,
  date: string,
): boolean {
  return completions[date]?.[habitId] === true
}

/** Consecutive completed days ending at the most recent day in the chain (today counts only if done). */
function habitStreak(
  completions: Persisted['completions'],
  habitId: string,
): number {
  const today = formatYMD(new Date())
  const d = new Date()
  if (!isCompleted(completions, habitId, today)) {
    d.setDate(d.getDate() - 1)
  }
  let streak = 0
  for (;;) {
    const key = formatYMD(d)
    if (!isCompleted(completions, habitId, key)) break
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}

type AppData = {
  habits: Habit[]
  completions: Persisted['completions']
  bestStreakByHabitId: Record<string, number>
  milestoneSeen: Record<string, Record<string, true>>
}

type ToastItem = { id: string; title: string; body: string }

export default function App() {
  const [data, setData] = useState<AppData>(() => {
    const p = loadPersisted()
    return {
      habits: p.habits,
      completions: p.completions,
      bestStreakByHabitId: p.bestStreakByHabitId,
      milestoneSeen: p.milestoneSeen,
    }
  })
  const { habits, completions, bestStreakByHabitId, milestoneSeen } = data
  const [newName, setNewName] = useState('')
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const milestoneToastDedupeRef = useRef(new Set<string>())
  const pendingMilestonesRef = useRef<{ name: string; m: number }[]>([])

  const now = new Date()
  const today = formatYMD(now)

  useEffect(() => {
    savePersisted({
      version: 2,
      habits,
      completions,
      bestStreakByHabitId,
      milestoneSeen,
    })
  }, [habits, completions, bestStreakByHabitId, milestoneSeen])

  useEffect(() => {
    pendingMilestonesRef.current = []
    setData((d) => {
      const pending = pendingMilestonesRef.current
      const nextBest = { ...d.bestStreakByHabitId }
      const nextSeen = cloneMilestoneSeen(d.milestoneSeen)
      let changed = false

      for (const h of d.habits) {
        const streak = habitStreak(d.completions, h.id)
        const prevBest = nextBest[h.id] ?? 0
        if (streak > prevBest) {
          nextBest[h.id] = streak
          changed = true
        }

        for (const m of STREAK_MILESTONES) {
          const key = String(m)
          if (streak >= m && !nextSeen[h.id]?.[key]) {
            nextSeen[h.id] = { ...(nextSeen[h.id] ?? {}), [key]: true }
            changed = true
            const dedupe = `${h.id}-${m}`
            if (!milestoneToastDedupeRef.current.has(dedupe)) {
              milestoneToastDedupeRef.current.add(dedupe)
              pending.push({ name: h.name, m })
            }
          }
        }
      }

      if (!changed) return d

      return {
        ...d,
        bestStreakByHabitId: nextBest,
        milestoneSeen: nextSeen,
      }
    })

    const pending = pendingMilestonesRef.current
    if (pending.length === 0) return

    pending.forEach((t, i) => {
      window.setTimeout(() => {
        const id = crypto.randomUUID()
        setToasts((prev) => [
          ...prev,
          {
            id,
            title:
              t.m === 7
                ? 'One week strong'
                : t.m === 30
                  ? '30-day milestone'
                  : 'Triple digits',
            body: `${t.name} — ${t.m}-day streak unlocked.`,
          },
        ])
        window.setTimeout(() => {
          setToasts((prev) => prev.filter((x) => x.id !== id))
        }, 5200)
      }, i * 480)
    })
  }, [habits, completions])

  const completedToday = useMemo(() => {
    const day = completions[today] ?? {}
    return habits.filter((h) => day[h.id]).length
  }, [habits, completions, today])

  const total = habits.length
  const allDone = total > 0 && completedToday === total
  const progressPct = total === 0 ? 0 : Math.round((completedToday / total) * 100)

  const toggle = useCallback(
    (habitId: string) => {
      setData((s) => {
        const next: Persisted['completions'] = { ...s.completions }
        const day = { ...(next[today] ?? {}) }
        if (day[habitId]) {
          delete day[habitId]
        } else {
          day[habitId] = true
        }
        let nextCompletions: Persisted['completions']
        if (Object.keys(day).length === 0) {
          nextCompletions = { ...next }
          delete nextCompletions[today]
        } else {
          nextCompletions = { ...next, [today]: day }
        }
        return { ...s, completions: nextCompletions }
      })
    },
    [today],
  )

  const addHabit = useCallback(() => {
    const name = newName.trim()
    if (!name) return
    setData((s) => ({
      ...s,
      habits: [...s.habits, { id: crypto.randomUUID(), name }],
    }))
    setNewName('')
  }, [newName])

  const deleteHabit = useCallback((id: string, name: string) => {
    const ok = window.confirm(`Remove habit "${name}"? This cannot be undone.`)
    if (!ok) return
    setData((s) => {
      const nextCompletions: Persisted['completions'] = {}
      for (const [date, map] of Object.entries(s.completions)) {
        const copy = { ...map }
        delete copy[id]
        if (Object.keys(copy).length > 0) nextCompletions[date] = copy
      }
      const nextBest = { ...s.bestStreakByHabitId }
      delete nextBest[id]
      const nextSeen = { ...s.milestoneSeen }
      delete nextSeen[id]
      for (const k of milestoneToastDedupeRef.current) {
        if (k.startsWith(`${id}-`)) milestoneToastDedupeRef.current.delete(k)
      }
      return {
        habits: s.habits.filter((h) => h.id !== id),
        completions: nextCompletions,
        bestStreakByHabitId: nextBest,
        milestoneSeen: nextSeen,
      }
    })
  }, [])

  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100 antialiased">
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:p-6"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-habit-done pointer-events-auto w-full max-w-md rounded-2xl border border-amber-500/35 bg-zinc-900/95 px-4 py-3 shadow-xl shadow-black/40 backdrop-blur-md"
            role="status"
          >
            <p className="text-sm font-semibold text-amber-200">{t.title}</p>
            <p className="mt-0.5 text-sm text-zinc-300">{t.body}</p>
          </div>
        ))}
      </div>

      <div className="mx-auto flex min-h-dvh max-w-lg flex-col px-4 pb-10 pt-8 sm:px-6 sm:pt-12">
        <header className="mb-8 space-y-1">
          <p className="text-sm font-medium tracking-wide text-zinc-500">
            {dateLabel}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Today
          </h1>
        </header>

        <section
          className="mb-8 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-4 shadow-inner shadow-black/20 backdrop-blur-sm"
          aria-live="polite"
        >
          <div className="mb-3 flex items-center justify-between gap-3 text-sm">
            <span className="text-zinc-400">
              {total === 0 ? (
                'No habits yet'
              ) : (
                <>
                  <span className="font-medium text-zinc-200">
                    {completedToday}
                  </span>
                  <span className="text-zinc-500"> of </span>
                  <span className="font-medium text-zinc-200">{total}</span>
                  <span className="text-zinc-500"> habits completed today</span>
                </>
              )}
            </span>
            {total > 0 && (
              <span className="tabular-nums text-zinc-500">{progressPct}%</span>
            )}
          </div>
          <div
            className="h-2.5 overflow-hidden rounded-full bg-zinc-800"
            role="progressbar"
            aria-valuenow={completedToday}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-label="Habits completed today"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </section>

        {allDone && (
          <div className="animate-habit-done mb-6 overflow-hidden rounded-2xl border border-emerald-500/30 bg-emerald-950/40 px-4 py-4 text-center">
            <p className="text-lg font-semibold text-emerald-200">
              All done for today
            </p>
            <p className="mt-1 text-sm text-emerald-400/90">
              Nice work — see you tomorrow.
            </p>
          </div>
        )}

        <ul className="flex flex-1 flex-col gap-3">
          {habits.map((habit) => {
            const done = isCompleted(completions, habit.id, today)
            const streak = habitStreak(completions, habit.id)
            const best = bestStreakByHabitId[habit.id] ?? 0
            const showStreakRow = streak > 0 || best > 0
            return (
              <li
                key={habit.id}
                className="group flex items-stretch gap-3 rounded-2xl border border-zinc-800/90 bg-zinc-900/50 p-3 shadow-sm transition-colors hover:border-zinc-700/90"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={() => toggle(habit.id)}
                      className="peer absolute h-full w-full cursor-pointer opacity-0"
                    />
                    <span
                      className={[
                        'flex h-10 w-10 items-center justify-center rounded-xl border-2 transition-all duration-300 ease-out',
                        done
                          ? 'scale-100 border-emerald-400 bg-emerald-500/20 shadow-[0_0_0_4px_rgba(16,185,129,0.15)]'
                          : 'border-zinc-600 bg-zinc-800/80 peer-hover:border-zinc-500 peer-active:scale-95',
                      ].join(' ')}
                      aria-hidden
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className={[
                          'h-5 w-5 transition-all duration-300 ease-out',
                          done
                            ? 'scale-100 opacity-100 text-emerald-300'
                            : 'scale-50 opacity-0',
                        ].join(' ')}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={[
                        'block truncate text-base font-medium transition-colors duration-200',
                        done ? 'text-zinc-400 line-through decoration-zinc-600' : 'text-zinc-100',
                      ].join(' ')}
                    >
                      {habit.name}
                    </span>
                    {showStreakRow && (
                      <span className="mt-0.5 block text-xs text-amber-400/95">
                        🔥 {streak}
                        {best > 0 ? (
                          <span className="text-zinc-500"> (best: {best})</span>
                        ) : null}
                      </span>
                    )}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => deleteHabit(habit.id, habit.name)}
                  className="shrink-0 self-center rounded-lg px-2 py-2 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                  aria-label={`Delete ${habit.name}`}
                >
                  Delete
                </button>
              </li>
            )
          })}
        </ul>

        <section className="mt-8 border-t border-zinc-800/80 pt-6">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">
            Add habit
          </h2>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addHabit()
              }}
              placeholder="New habit name"
              className="min-h-11 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-zinc-100 placeholder:text-zinc-600 outline-none ring-emerald-500/40 transition-shadow focus:border-emerald-600/70 focus:ring-2"
            />
            <button
              type="button"
              onClick={addHabit}
              className="min-h-11 shrink-0 rounded-xl bg-zinc-100 px-5 font-medium text-zinc-900 transition-transform active:scale-[0.98] hover:bg-white"
            >
              Add
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
