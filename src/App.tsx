import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const STORAGE_KEY = 'habit-tracker-v1'
const STREAK_MILESTONES = [7, 30, 100] as const

const PRESET_CATEGORIES = [
  'Health',
  'Fitness',
  'Career',
  'Mindset',
  'Other',
] as const

const COLOR_PRESETS = [
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#f97316',
  '#eab308',
  '#ef4444',
  '#06b6d4',
  '#a855f7',
  '#64748b',
] as const

const EMOJI_ICONS = [
  '🔥',
  '💪',
  '📚',
  '🧠',
  '💧',
  '🏃',
  '🎯',
  '✨',
  '🌅',
  '🍎',
  '💼',
  '🧘',
  '❄️',
  '✅',
  '⭐️',
  '📝',
  '🥗',
  '🛏️',
  '☀️',
  '🎵',
  '❤️',
] as const

const DEFAULT_HABIT_SEED: {
  name: string
  category: string
  color: string
  icon: string
}[] = [
  { name: 'Apply to Jobs', category: 'Career', color: '#3b82f6', icon: '💼' },
  { name: 'Exercise', category: 'Fitness', color: '#f97316', icon: '🏃' },
  { name: 'Creatine', category: 'Health', color: '#22c55e', icon: '💧' },
  { name: 'Supplements', category: 'Health', color: '#14b8a6', icon: '🍎' },
  { name: 'Mobility', category: 'Fitness', color: '#8b5cf6', icon: '🧘' },
  { name: 'Cold Shower', category: 'Health', color: '#06b6d4', icon: '❄️' },
]

type Habit = {
  id: string
  name: string
  category: string
  color: string
  icon: string
}

/** category name → ordered habit ids within that category */
type HabitOrderMap = Record<string, string[]>

type Persisted = {
  version: 4
  habits: Habit[]
  /** YYYY-MM-DD → habitId → completed */
  completions: Record<string, Record<string, true>>
  bestStreakByHabitId: Record<string, number>
  /** habitId → milestone day string "7" | "30" | "100" → shown once */
  milestoneSeen: Record<string, Record<string, true>>
  /** User-defined category labels (not in presets) */
  customCategories: string[]
  habitOrderByCategory: HabitOrderMap
}

function formatYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseYMD(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Monday 00:00 local for the calendar week containing `end` (week starts Monday). */
function startOfWeekMonday(end: Date): Date {
  const d = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const dow = d.getDay()
  const offset = dow === 0 ? -6 : 1 - dow
  d.setDate(d.getDate() + offset)
  return d
}

function startOfMonth(end: Date): Date {
  return new Date(end.getFullYear(), end.getMonth(), 1)
}

/** Inclusive calendar dates from `start` through `end` (local), as YYYY-MM-DD. */
function enumerateYMDInclusive(start: Date, end: Date): string[] {
  const out: string[] = []
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  while (cur <= last) {
    out.push(formatYMD(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

function ymdCompare(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** First day of the calendar month `monthsAgo` months before `anchorYMD`. */
function monthFirstYMD(anchorYMD: string, monthsAgo: number): string {
  const d = parseYMD(anchorYMD)
  d.setMonth(d.getMonth() - monthsAgo)
  d.setDate(1)
  return formatYMD(d)
}

/** Sunday on or before `d` (local). */
function startOfWeekSunday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = x.getDay()
  x.setDate(x.getDate() - dow)
  return x
}

/** Saturday on or after `d` (local). */
function endOfWeekSaturday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = x.getDay()
  if (dow !== 6) x.setDate(x.getDate() + (6 - dow))
  return x
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return null
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

type RateResult = { done: number; total: number; pct: number }

function completionRateHabit(
  completions: Persisted['completions'],
  habitId: string,
  dates: string[],
): RateResult {
  const total = dates.length
  if (total === 0) return { done: 0, total: 0, pct: 0 }
  let done = 0
  for (const date of dates) {
    if (completions[date]?.[habitId]) done++
  }
  return { done, total, pct: Math.round((done / total) * 100) }
}

function formatRateTooltip(week: RateResult, month: RateResult): string {
  const w =
    week.total === 0
      ? 'This week: —'
      : `This week: ${week.pct}% (${week.done}/${week.total} checks)`
  const mo =
    month.total === 0
      ? 'This month: —'
      : `This month: ${month.pct}% (${month.done}/${month.total} checks)`
  return `${w} · ${mo}`
}

function isHexColor(s: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(s)
}

function normalizeHabit(h: unknown, index: number): Habit | null {
  if (!h || typeof h !== 'object') return null
  const o = h as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || !o.name.trim())
    return null

  const seed = DEFAULT_HABIT_SEED.find((s) => s.name === o.name)

  let category =
    typeof o.category === 'string' && o.category.trim()
      ? o.category.trim()
      : seed?.category ?? 'Other'

  const colorRaw = typeof o.color === 'string' ? o.color.trim() : ''
  let color = isHexColor(colorRaw)
    ? colorRaw
    : seed?.color ?? COLOR_PRESETS[index % COLOR_PRESETS.length]

  const iconRaw = typeof o.icon === 'string' ? o.icon.trim() : ''
  const iconFromSet = (EMOJI_ICONS as readonly string[]).includes(iconRaw)
    ? iconRaw
    : seed?.icon ?? EMOJI_ICONS[index % EMOJI_ICONS.length]

  return {
    id: o.id,
    name: o.name.trim(),
    category,
    color,
    icon: iconFromSet,
  }
}

function mergeOrderWithHabits(
  category: string,
  habitsInCat: Habit[],
  orderMap: HabitOrderMap,
): Habit[] {
  const ids = orderMap[category] ?? []
  const byId = new Map(habitsInCat.map((h) => [h.id, h]))
  const inCat = new Set(habitsInCat.map((h) => h.id))
  const seen = new Set<string>()
  const out: Habit[] = []
  for (const id of ids) {
    if (!inCat.has(id)) continue
    const h = byId.get(id)
    if (h) {
      out.push(h)
      seen.add(id)
    }
  }
  for (const h of habitsInCat) {
    if (!seen.has(h.id)) out.push(h)
  }
  return out
}

function sanitizeHabitOrderMap(
  habits: Habit[],
  orderMap: HabitOrderMap,
): HabitOrderMap {
  const byCat = new Map<string, Habit[]>()
  for (const h of habits) {
    const c = h.category?.trim() || 'Other'
    if (!byCat.has(c)) byCat.set(c, [])
    byCat.get(c)!.push(h)
  }
  const out: HabitOrderMap = {}
  for (const [cat, list] of byCat) {
    const known = new Set(list.map((h) => h.id))
    const prev = orderMap[cat] ?? []
    const next: string[] = []
    const used = new Set<string>()
    for (const id of prev) {
      if (known.has(id) && !used.has(id)) {
        next.push(id)
        used.add(id)
      }
    }
    for (const h of list) {
      if (!used.has(h.id)) next.push(h.id)
    }
    out[cat] = next
  }
  return out
}

function findCategoryForHabitId(
  habits: Habit[],
  habitId: string,
): string | null {
  const h = habits.find((x) => x.id === habitId)
  return h ? (h.category?.trim() || 'Other') : null
}

function mergeCustomCategories(
  stored: string[] | undefined,
  habits: Habit[],
): string[] {
  const preset = new Set<string>(PRESET_CATEGORIES as unknown as string[])
  const out: string[] = []
  if (Array.isArray(stored)) {
    for (const c of stored) {
      if (typeof c !== 'string') continue
      const t = c.trim()
      if (!t || preset.has(t)) continue
      if (!out.includes(t)) out.push(t)
    }
  }
  for (const h of habits) {
    if (!preset.has(h.category) && !out.includes(h.category)) {
      out.push(h.category)
    }
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

function defaultHabits(): Habit[] {
  return DEFAULT_HABIT_SEED.map((s) => ({
    id: crypto.randomUUID(),
    name: s.name,
    category: s.category,
    color: s.color,
    icon: s.icon,
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
    const historyMax = maxConsecutiveStreakInHistory(completions, h.id)
    bestStreakByHabitId[h.id] = historyMax
    const seen: Record<string, true> = {}
    for (const m of STREAK_MILESTONES) {
      if (historyMax >= m || streak >= m) seen[String(m)] = true
    }
    if (Object.keys(seen).length > 0) milestoneSeen[h.id] = seen
  }
  return { bestStreakByHabitId, milestoneSeen }
}

function loadPersisted(): Persisted {
  const empty = (): Persisted => ({
    version: 4,
    habits: defaultHabits(),
    completions: {},
    bestStreakByHabitId: {},
    milestoneSeen: {},
    customCategories: [],
    habitOrderByCategory: {},
  })

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty()

    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object') return empty()

    const rec = data as Record<string, unknown>
    const habitsRaw = rec.habits
    if (!Array.isArray(habitsRaw)) return empty()

    const completions =
      rec.completions && typeof rec.completions === 'object'
        ? (rec.completions as Persisted['completions'])
        : {}

    const normalizedHabits: Habit[] = []
    for (const h of habitsRaw) {
      const nh = normalizeHabit(h, normalizedHabits.length)
      if (nh) normalizedHabits.push(nh)
    }
    if (normalizedHabits.length === 0) return empty()

    const ver = rec.version
    let bestStreakByHabitId: Record<string, number> = {}
    let milestoneSeen: Record<string, Record<string, true>> = {}

    if (ver !== 4) {
      const bf = backfillStreakFields(normalizedHabits, completions)
      bestStreakByHabitId = bf.bestStreakByHabitId
      milestoneSeen = bf.milestoneSeen
    } else {
      if (rec.bestStreakByHabitId && typeof rec.bestStreakByHabitId === 'object') {
        for (const [k, v] of Object.entries(rec.bestStreakByHabitId)) {
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
            bestStreakByHabitId[k] = Math.floor(v)
          }
        }
      }
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
      for (const h of normalizedHabits) {
        const streak = habitStreak(completions, h.id)
        const historyMax = maxConsecutiveStreakInHistory(completions, h.id)
        bestStreakByHabitId[h.id] = historyMax
        for (const m of STREAK_MILESTONES) {
          if (historyMax >= m || streak >= m) {
            if (!milestoneSeen[h.id]) milestoneSeen[h.id] = {}
            milestoneSeen[h.id][String(m)] = true
          }
        }
      }
    }

    const storedCustom = Array.isArray(rec.customCategories)
      ? (rec.customCategories as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined
    const customCategories = mergeCustomCategories(storedCustom, normalizedHabits)

    let habitOrderByCategory: HabitOrderMap = {}
    if (
      ver === 4 &&
      rec.habitOrderByCategory &&
      typeof rec.habitOrderByCategory === 'object'
    ) {
      for (const [k, v] of Object.entries(
        rec.habitOrderByCategory as Record<string, unknown>,
      )) {
        if (typeof k !== 'string' || !Array.isArray(v)) continue
        habitOrderByCategory[k] = v.filter(
          (x): x is string => typeof x === 'string',
        )
      }
    }
    habitOrderByCategory = sanitizeHabitOrderMap(
      normalizedHabits,
      habitOrderByCategory,
    )

    return {
      version: 4,
      habits: normalizedHabits,
      completions,
      bestStreakByHabitId,
      milestoneSeen,
      customCategories,
      habitOrderByCategory,
    }
  } catch {
    return empty()
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

/** Longest calendar run of completed days for this habit anywhere in stored history (drops when days are unchecked). */
function maxConsecutiveStreakInHistory(
  completions: Persisted['completions'],
  habitId: string,
): number {
  const dates: string[] = []
  for (const [date, map] of Object.entries(completions)) {
    if (map?.[habitId] === true) dates.push(date)
  }
  if (dates.length === 0) return 0
  dates.sort()
  let bestRun = 1
  let curRun = 1
  const dayMs = 86400000
  for (let i = 1; i < dates.length; i++) {
    const a = parseYMD(dates[i - 1])
    const b = parseYMD(dates[i])
    const diff = Math.round((b.getTime() - a.getTime()) / dayMs)
    if (diff === 1) {
      curRun++
      if (curRun > bestRun) bestRun = curRun
    } else if (diff !== 0) {
      curRun = 1
    }
  }
  return bestRun
}

type AppData = {
  habits: Habit[]
  completions: Persisted['completions']
  bestStreakByHabitId: Record<string, number>
  milestoneSeen: Record<string, Record<string, true>>
  customCategories: string[]
  habitOrderByCategory: HabitOrderMap
}

type ToastItem = { id: string; title: string; body: string }

type HabitDraft = {
  name: string
  category: string
  color: string
  icon: string
}

type SortableHabitRowProps = {
  habit: Habit
  logDate: string
  dragDisabled?: boolean
  completions: Persisted['completions']
  habitRates: Record<string, { week: RateResult; month: RateResult }>
  bestStreakByHabitId: Record<string, number>
  onToggle: (id: string) => void
  onDelete: (id: string, name: string) => void
  onEdit: (id: string) => void
}

function SortableHabitRow({
  habit,
  logDate,
  dragDisabled = false,
  completions,
  habitRates,
  bestStreakByHabitId,
  onToggle,
  onDelete,
  onEdit,
}: SortableHabitRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: habit.id, disabled: dragDisabled })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
  }

  const done = isCompleted(completions, habit.id, logDate)
  const streak = habitStreak(completions, habit.id)
  const best = bestStreakByHabitId[habit.id] ?? 0
  const showStreakRow = streak > 0 || best > 0
  const hr = habitRates[habit.id]

  return (
    <li
      ref={setNodeRef}
      {...(dragDisabled ? attributes : {})}
      style={{
        ...style,
        borderLeft: `3px solid ${habit.color}`,
        opacity: isDragging ? 0.92 : undefined,
      }}
      title={formatRateTooltip(hr.week, hr.month)}
      className="group flex items-stretch gap-1 rounded-2xl border border-y border-r border-zinc-800/90 bg-zinc-900/50 py-2 pl-1 pr-2 shadow-sm transition-colors hover:border-zinc-700/90"
    >
      <button
        type="button"
        disabled={dragDisabled}
        className={[
          'flex w-8 shrink-0 touch-none items-center justify-center rounded-lg text-zinc-500',
          dragDisabled
            ? 'cursor-default opacity-40'
            : 'cursor-grab hover:bg-zinc-800 hover:text-zinc-300 active:cursor-grabbing',
        ].join(' ')}
        aria-label={
          dragDisabled ? `Reorder unavailable` : `Reorder ${habit.name}`
        }
        {...(dragDisabled ? {} : attributes)}
        {...(dragDisabled ? {} : listeners)}
      >
        <svg
          className="h-5 w-5"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <circle cx="6" cy="5" r="1.5" />
          <circle cx="14" cy="5" r="1.5" />
          <circle cx="6" cy="10" r="1.5" />
          <circle cx="14" cy="10" r="1.5" />
          <circle cx="6" cy="15" r="1.5" />
          <circle cx="14" cy="15" r="1.5" />
        </svg>
      </button>
      <span
        className="flex w-9 shrink-0 select-none items-center justify-center text-xl leading-none"
        aria-hidden
      >
        {habit.icon}
      </span>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={done}
            onChange={() => onToggle(habit.id)}
            className="peer absolute h-full w-full cursor-pointer opacity-0"
          />
          <span
            className={[
              'flex h-10 w-10 items-center justify-center rounded-xl border-2 transition-all duration-300 ease-out',
              done
                ? 'scale-100 shadow-[0_0_0_4px_rgba(255,255,255,0.06)]'
                : 'border-zinc-600 bg-zinc-800/80 peer-hover:border-zinc-500 peer-active:scale-95',
            ].join(' ')}
            style={
              done
                ? {
                    borderColor: habit.color,
                    backgroundColor: `${habit.color}22`,
                  }
                : undefined
            }
            aria-hidden
          >
            <svg
              viewBox="0 0 24 24"
              className={[
                'h-5 w-5 transition-all duration-300 ease-out',
                done ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
              ].join(' ')}
              style={done ? { color: habit.color } : undefined}
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
              done
                ? 'text-zinc-400 line-through decoration-zinc-600'
                : 'text-zinc-100',
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
      <div className="flex shrink-0 flex-col justify-center gap-0.5 self-stretch sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => onEdit(habit.id)}
          className="rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => onDelete(habit.id, habit.name)}
          className="rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          aria-label={`Delete ${habit.name}`}
        >
          Delete
        </button>
      </div>
    </li>
  )
}

const HEATMAP_ACCENT_DEFAULT = '#22c55e'

function dayOverallCompletion(
  ymd: string,
  habits: Habit[],
  completions: Persisted['completions'],
): { done: number; total: number; pct: number } {
  const n = habits.length
  if (n === 0) return { done: 0, total: 0, pct: 0 }
  const map = completions[ymd]
  let done = 0
  for (const h of habits) {
    if (map?.[h.id]) done++
  }
  return { done, total: n, pct: Math.round((done / n) * 100) }
}

function anyHabitCompletedOnDate(
  completions: Persisted['completions'],
  habits: Habit[],
  ymd: string,
): boolean {
  if (habits.length === 0) return false
  const map = completions[ymd]
  if (!map) return false
  for (const h of habits) {
    if (map[h.id]) return true
  }
  return false
}

/** Consecutive days (ending today-or-yesterday rule) where at least one habit was completed. */
function globalActivityStreak(
  completions: Persisted['completions'],
  habits: Habit[],
  todayYMD: string,
): number {
  if (habits.length === 0) return 0
  const d = parseYMD(todayYMD)
  if (!anyHabitCompletedOnDate(completions, habits, todayYMD)) {
    d.setDate(d.getDate() - 1)
  }
  let streak = 0
  for (;;) {
    const key = formatYMD(d)
    if (!anyHabitCompletedOnDate(completions, habits, key)) break
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}

function datesWithAnyActivity(
  completions: Persisted['completions'],
  habits: Habit[],
): string[] {
  const set = new Set<string>()
  for (const [date, map] of Object.entries(completions)) {
    if (!map) continue
    for (const h of habits) {
      if (map[h.id]) {
        set.add(date)
        break
      }
    }
  }
  return [...set].sort()
}

function maxGlobalActivityStreakInHistory(
  completions: Persisted['completions'],
  habits: Habit[],
): number {
  const dates = datesWithAnyActivity(completions, habits)
  if (dates.length === 0) return 0
  let bestRun = 1
  let curRun = 1
  const dayMs = 86400000
  for (let i = 1; i < dates.length; i++) {
    const a = parseYMD(dates[i - 1])
    const b = parseYMD(dates[i])
    const diff = Math.round((b.getTime() - a.getTime()) / dayMs)
    if (diff === 1) {
      curRun++
      if (curRun > bestRun) bestRun = curRun
    } else if (diff !== 0) {
      curRun = 1
    }
  }
  return bestRun
}

function totalCompletionChecks(
  completions: Persisted['completions'],
  habits: Habit[],
): number {
  if (habits.length === 0) return 0
  const ids = new Set(habits.map((h) => h.id))
  let n = 0
  for (const map of Object.values(completions)) {
    if (!map) continue
    for (const [id, v] of Object.entries(map)) {
      if (v === true && ids.has(id)) n++
    }
  }
  return n
}

function isPerfectDay(
  ymd: string,
  completions: Persisted['completions'],
  habits: Habit[],
): boolean {
  if (habits.length === 0) return false
  const map = completions[ymd]
  if (!map) return false
  for (const h of habits) {
    if (!map[h.id]) return false
  }
  return true
}

function countPerfectDaysAllTime(
  completions: Persisted['completions'],
  habits: Habit[],
): number {
  if (habits.length === 0) return 0
  let c = 0
  for (const date of Object.keys(completions)) {
    if (isPerfectDay(date, completions, habits)) c++
  }
  return c
}

function perfectDaysThisMonth(
  completions: Persisted['completions'],
  habits: Habit[],
  todayYMD: string,
): { perfect: number; elapsed: number } {
  const end = parseYMD(todayYMD)
  const start = startOfMonth(end)
  const days = enumerateYMDInclusive(start, end)
  if (habits.length === 0) return { perfect: 0, elapsed: days.length }
  let perfect = 0
  for (const ymd of days) {
    if (isPerfectDay(ymd, completions, habits)) perfect++
  }
  return { perfect, elapsed: days.length }
}

function nextStreakMilestone(streak: number): number | null {
  for (const m of STREAK_MILESTONES) {
    if (streak < m) return m
  }
  return null
}

type HeatmapStatsViewProps = {
  habits: Habit[]
  completions: Persisted['completions']
  todayYMD: string
}

function HeatmapStatsView({
  habits,
  completions,
  todayYMD,
}: HeatmapStatsViewProps) {
  const [focusHabitId, setFocusHabitId] = useState('')

  const glance = useMemo(() => {
    const currentGlobal = globalActivityStreak(
      completions,
      habits,
      todayYMD,
    )
    const bestGlobal = maxGlobalActivityStreakInHistory(completions, habits)
    const totalChecks = totalCompletionChecks(completions, habits)
    const perfectAll = countPerfectDaysAllTime(completions, habits)
    const { perfect: perfectMonth, elapsed: elapsedMonth } =
      perfectDaysThisMonth(completions, habits, todayYMD)
    return {
      currentGlobal,
      bestGlobal,
      totalChecks,
      perfectAll,
      perfectMonth,
      elapsedMonth,
    }
  }, [habits, completions, todayYMD])

  const upcomingMilestones = useMemo(() => {
    type Row = { habit: Habit; streak: number; next: number; gap: number }
    const rows: Row[] = []
    for (const h of habits) {
      const streak = habitStreak(completions, h.id)
      const next = nextStreakMilestone(streak)
      if (next === null) continue
      const gap = next - streak
      if (gap >= 1 && gap <= 5) rows.push({ habit: h, streak, next, gap })
    }
    rows.sort((a, b) => a.gap - b.gap || b.streak - a.streak)
    return rows
  }, [habits, completions])

  const rangeStartYMD = useMemo(() => monthFirstYMD(todayYMD, 2), [todayYMD])

  const columns = useMemo(() => {
    const rangeStart = parseYMD(rangeStartYMD)
    const rangeEnd = parseYMD(todayYMD)
    const gridStart = startOfWeekSunday(rangeStart)
    const gridEnd = endOfWeekSaturday(rangeEnd)
    const cols: { ymd: string; inRange: boolean }[][] = []
    const weekStart = new Date(gridStart)
    while (weekStart <= gridEnd) {
      const col: { ymd: string; inRange: boolean }[] = []
      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart)
        d.setDate(weekStart.getDate() + i)
        const ymd = formatYMD(d)
        const inRange =
          ymdCompare(ymd, rangeStartYMD) >= 0 && ymdCompare(ymd, todayYMD) <= 0
        col.push({ ymd, inRange })
      }
      cols.push(col)
      weekStart.setDate(weekStart.getDate() + 7)
    }
    return cols
  }, [todayYMD, rangeStartYMD])

  const focusHabit = habits.find((h) => h.id === focusHabitId)
  const accentHex = focusHabit?.color ?? HEATMAP_ACCENT_DEFAULT
  const rgb = hexToRgb(accentHex) ?? { r: 34, g: 197, b: 94 }

  const monthLabelForColumn = (col: { ymd: string; inRange: boolean }[]) => {
    for (const cell of col) {
      if (!cell.inRange) continue
      const d = parseYMD(cell.ymd)
      if (d.getDate() === 1) {
        return d.toLocaleDateString(undefined, { month: 'short' })
      }
    }
    return ''
  }

  const cellStyle = (
    inRange: boolean,
    pct: number,
  ): CSSProperties => {
    if (!inRange) {
      return {
        backgroundColor: 'rgba(39, 39, 42, 0.35)',
        border: '1px solid rgba(63, 63, 70, 0.5)',
      }
    }
    if (habits.length === 0) {
      return {
        backgroundColor: 'rgba(39, 39, 42, 0.5)',
        border: '1px solid rgba(63, 63, 70, 0.6)',
      }
    }
    if (pct <= 0) {
      return {
        backgroundColor: 'transparent',
        border: '1px solid rgba(63, 63, 70, 0.85)',
      }
    }
    const alpha = 0.12 + (pct / 100) * 0.88
    return {
      backgroundColor: `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`,
      border: `1px solid rgba(${rgb.r},${rgb.g},${rgb.b},${0.35 + (pct / 100) * 0.45})`,
    }
  }

  const weekDayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Stats
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Summary and milestones from your history — then the activity
          calendar.
        </p>
      </div>

      <section aria-labelledby="stats-glance-heading">
        <h2
          id="stats-glance-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500"
        >
          At a glance
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-950/60 via-zinc-900/90 to-zinc-950 p-4 shadow-lg shadow-black/20">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-200/90">
              Streak
            </p>
            <p className="mt-3 text-sm leading-relaxed text-zinc-200">
              <span aria-hidden>🔥</span>{' '}
              <span className="font-semibold tabular-nums text-white">
                {glance.currentGlobal}
              </span>{' '}
              day{glance.currentGlobal === 1 ? '' : 's'} current
              <span className="mx-2 text-zinc-600">|</span>
              <span aria-hidden>🏆</span>{' '}
              <span className="font-semibold tabular-nums text-white">
                {glance.bestGlobal}
              </span>{' '}
              day{glance.bestGlobal === 1 ? '' : 's'} best
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              Any day you complete at least one habit counts.
            </p>
          </div>

          <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-950/50 via-zinc-900/90 to-zinc-950 p-4 shadow-lg shadow-black/20">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-200/90">
              Total completions
            </p>
            <p className="mt-2 flex flex-wrap items-baseline gap-2">
              <span className="text-3xl font-bold tabular-nums tracking-tight text-white sm:text-4xl">
                {glance.totalChecks.toLocaleString()}
              </span>
              <span className="text-base text-emerald-400/95" aria-hidden>
                ✅
              </span>
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Every habit check ever saved.
            </p>
          </div>

          <div className="rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-950/45 via-zinc-900/90 to-zinc-950 p-4 shadow-lg shadow-black/20">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-200/90">
              Perfect days
            </p>
            <p className="mt-3 text-sm text-zinc-200">
              <span aria-hidden>⭐</span>{' '}
              <span className="font-semibold tabular-nums text-white">
                {glance.perfectAll}
              </span>{' '}
              perfect day{glance.perfectAll === 1 ? '' : 's'}{' '}
              <span className="text-zinc-500">
                ({glance.perfectMonth} this month)
              </span>
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              {glance.perfectMonth} of {glance.elapsedMonth} day
              {glance.elapsedMonth === 1 ? '' : 's'} in this month so far — every
              habit done.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="stats-milestones-heading">
        <h2
          id="stats-milestones-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500"
        >
          Upcoming milestones
        </h2>
        {upcomingMilestones.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 px-4 py-8 text-center">
            <p className="text-lg text-zinc-300">Keep going — milestones are coming!</p>
            <p className="mt-2 text-sm text-zinc-500">
              When you are within 5 days of a 7-, 30-, or 100-day streak, we will
              cheer you on here.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {upcomingMilestones.map(({ habit, streak, next, gap }) => {
              const pct = Math.min(100, Math.round((streak / next) * 100))
              const dayWord = gap === 1 ? 'day' : 'days'
              return (
                <li
                  key={habit.id}
                  className="rounded-2xl border border-zinc-800/90 bg-zinc-900/60 p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <span
                      className="text-2xl leading-none"
                      aria-hidden
                    >
                      {habit.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-zinc-100">{habit.name}</p>
                      <p className="mt-1 text-sm text-zinc-400">
                        Streak{' '}
                        <span className="tabular-nums text-amber-300/95">
                          {streak}
                        </span>
                        {' — '}
                        <span className="text-zinc-300">
                          {gap} more {dayWord} to your {next}-day streak 🎯
                        </span>
                      </p>
                      <div
                        className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800"
                        role="progressbar"
                        aria-valuenow={streak}
                        aria-valuemin={0}
                        aria-valuemax={next}
                        aria-label={`Progress toward ${next}-day streak`}
                      >
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: habit.color,
                            opacity: 0.85,
                          }}
                        />
                      </div>
                      <p className="mt-1 text-right text-[10px] tabular-nums text-zinc-600">
                        {streak} / {next}
                      </p>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="stats-calendar-heading">
        <h2
          id="stats-calendar-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500"
        >
          Activity calendar
        </h2>
        <p className="mb-3 text-sm text-zinc-500">
          Last 3 calendar months — daily completion from your saved history.
        </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <span className="self-center text-xs font-medium uppercase tracking-wider text-zinc-500">
            View
          </span>
          <button
            type="button"
            onClick={() => setFocusHabitId('')}
            className={[
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              focusHabitId === ''
                ? 'bg-emerald-600/25 text-emerald-200 ring-1 ring-emerald-500/40'
                : 'border border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
            ].join(' ')}
          >
            All habits
          </button>
        </div>
        <label className="flex min-w-0 flex-col gap-1 sm:max-w-xs">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Per habit
          </span>
          <select
            value={focusHabitId}
            onChange={(e) => setFocusHabitId(e.target.value)}
            className="min-h-10 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-emerald-600/70 focus:ring-2 focus:ring-emerald-500/30"
          >
            <option value="">— Overall —</option>
            {habits.map((h) => (
              <option key={h.id} value={h.id}>
                {h.icon} {h.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {focusHabitId && focusHabit && (
        <p className="text-xs text-zinc-500">
          Showing <span className="text-zinc-300">{focusHabit.icon}</span>{' '}
          <span className="font-medium text-zinc-300">{focusHabit.name}</span>{' '}
          (done vs not per day).
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-zinc-800/90 bg-zinc-900/40 p-3">
        <div
          className="flex min-w-min gap-1"
          role="grid"
          aria-label="Completion heatmap, last three months"
        >
          <div
            className="flex flex-col justify-end gap-[3px] pr-1 pt-5 text-[10px] text-zinc-600"
            aria-hidden
          >
            {weekDayLabels.map((d) => (
              <div
                key={d}
                className="flex h-[11px] items-center sm:h-[13px]"
                style={{ lineHeight: 1 }}
              >
                {d[0]}
              </div>
            ))}
          </div>
          {columns.map((col, ci) => {
            const ml = monthLabelForColumn(col)
            return (
              <div
                key={ci}
                className="flex flex-col gap-[3px]"
                role="presentation"
              >
                <div className="h-4 text-[10px] leading-4 text-zinc-500">
                  {ml || '\u00a0'}
                </div>
                {col.map((cell) => {
                  let title: string
                  let pct = 0
                  let done = 0
                  let total = habits.length
                  const display = parseYMD(cell.ymd).toLocaleDateString(
                    undefined,
                    {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    },
                  )
                  if (!cell.inRange) {
                    title = `${display} (outside range)`
                  } else if (habits.length === 0) {
                    title = `${display} — add habits to track`
                  } else if (focusHabitId) {
                    const ok = !!completions[cell.ymd]?.[focusHabitId]
                    pct = ok ? 100 : 0
                    done = ok ? 1 : 0
                    total = 1
                    title = `${display} — ${ok ? 'Completed' : 'Not completed'} (1 habit)`
                  } else {
                    const o = dayOverallCompletion(
                      cell.ymd,
                      habits,
                      completions,
                    )
                    done = o.done
                    total = o.total
                    pct = o.pct
                    title = `${display} — ${done}/${total} habits (${pct}%)`
                  }
                  return (
                    <div
                      key={cell.ymd}
                      role="gridcell"
                      title={title}
                      style={{
                        ...cellStyle(cell.inRange, pct),
                        width: 11,
                        height: 11,
                        borderRadius: 2,
                      }}
                      className="shrink-0 cursor-default sm:h-[13px] sm:w-[13px]"
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>Less</span>
          <div className="flex gap-0.5">
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => (
              <div
                key={t}
                className="h-2.5 w-2.5 rounded-sm border border-zinc-700"
                style={{
                  backgroundColor:
                    t === 0
                      ? 'transparent'
                      : `rgba(${rgb.r},${rgb.g},${rgb.b},${0.12 + t * 0.88})`,
                }}
              />
            ))}
          </div>
          <span>More</span>
        </div>
      </div>
      </section>
    </div>
  )
}

export default function App() {
  const [data, setData] = useState<AppData>(() => {
    const p = loadPersisted()
    return {
      habits: p.habits,
      completions: p.completions,
      bestStreakByHabitId: p.bestStreakByHabitId,
      milestoneSeen: p.milestoneSeen,
      customCategories: p.customCategories,
      habitOrderByCategory: p.habitOrderByCategory,
    }
  })
  const {
    habits,
    completions,
    bestStreakByHabitId,
    milestoneSeen,
    customCategories,
    habitOrderByCategory,
  } = data
  const [habitModal, setHabitModal] = useState<
    null | { mode: 'add' } | { mode: 'edit'; id: string }
  >(null)
  const [draft, setDraft] = useState<HabitDraft>({
    name: '',
    category: PRESET_CATEGORIES[0],
    color: COLOR_PRESETS[0],
    icon: EMOJI_ICONS[0],
  })
  const [newCategoryInput, setNewCategoryInput] = useState('')
  const [logView, setLogView] = useState<'today' | 'yesterday'>('today')
  const [appTab, setAppTab] = useState<'track' | 'stats'>('track')
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const milestoneToastDedupeRef = useRef(new Set<string>())
  const pendingMilestonesRef = useRef<{ name: string; m: number }[]>([])

  const now = new Date()
  const today = formatYMD(now)
  const yesterdayYMD = useMemo(() => {
    const d = parseYMD(today)
    d.setDate(d.getDate() - 1)
    return formatYMD(d)
  }, [today])
  const activeLogDate = logView === 'yesterday' ? yesterdayYMD : today

  useEffect(() => {
    savePersisted({
      version: 4,
      habits,
      completions,
      bestStreakByHabitId,
      milestoneSeen,
      customCategories,
      habitOrderByCategory,
    })
  }, [
    habits,
    completions,
    bestStreakByHabitId,
    milestoneSeen,
    customCategories,
    habitOrderByCategory,
  ])

  useEffect(() => {
    if (!habitModal) return
    if (habitModal.mode === 'add') {
      setDraft({
        name: '',
        category: PRESET_CATEGORIES[0],
        color: COLOR_PRESETS[0],
        icon: EMOJI_ICONS[0],
      })
      setNewCategoryInput('')
      return
    }
    const h = habits.find((x) => x.id === habitModal.id)
    if (!h) {
      setHabitModal(null)
      return
    }
    setDraft({
      name: h.name,
      category: h.category,
      color: isHexColor(h.color) ? h.color : COLOR_PRESETS[0],
      icon: (EMOJI_ICONS as readonly string[]).includes(h.icon)
        ? h.icon
        : EMOJI_ICONS[0],
    })
    setNewCategoryInput('')
  }, [habitModal, habits])

  useEffect(() => {
    pendingMilestonesRef.current = []
    setData((d) => {
      const pending = pendingMilestonesRef.current
      const nextBest = { ...d.bestStreakByHabitId }
      const nextSeen = cloneMilestoneSeen(d.milestoneSeen)
      let changed = false

      for (const h of d.habits) {
        const streak = habitStreak(d.completions, h.id)
        const historyMax = maxConsecutiveStreakInHistory(d.completions, h.id)
        const prevBest = nextBest[h.id] ?? 0
        if (historyMax !== prevBest) {
          nextBest[h.id] = historyMax
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

  const completedForActiveDate = useMemo(() => {
    const day = completions[activeLogDate] ?? {}
    return habits.filter((h) => day[h.id]).length
  }, [habits, completions, activeLogDate])

  const habitRates = useMemo(() => {
    const end = parseYMD(today)
    const weekStart = startOfWeekMonday(end)
    const monthStart = startOfMonth(end)
    const wd = enumerateYMDInclusive(weekStart, end)
    const md = enumerateYMDInclusive(monthStart, end)
    const rates: Record<
      string,
      { week: RateResult; month: RateResult }
    > = {}
    for (const h of habits) {
      rates[h.id] = {
        week: completionRateHabit(completions, h.id, wd),
        month: completionRateHabit(completions, h.id, md),
      }
    }
    return rates
  }, [habits, completions, today])

  const categoryOptions = useMemo(() => {
    const customs = customCategories.filter(
      (c) => !(PRESET_CATEGORIES as readonly string[]).includes(c),
    )
    return [...PRESET_CATEGORIES, ...customs]
  }, [customCategories])

  const habitsByCategory = useMemo(() => {
    const map = new Map<string, Habit[]>()
    for (const h of habits) {
      const cat = h.category?.trim() || 'Other'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(h)
    }
    const preset = PRESET_CATEGORIES as readonly string[]
    const ordered: string[] = []
    for (const c of preset) {
      if (map.has(c)) ordered.push(c)
    }
    const rest = [...map.keys()].filter(
      (c) => !(preset as readonly string[]).includes(c),
    )
    rest.sort((a, b) => a.localeCompare(b))
    ordered.push(...rest)
    return ordered.map((category) => ({
      category,
      habits: mergeOrderWithHabits(
        category,
        map.get(category)!,
        habitOrderByCategory,
      ),
    }))
  }, [habits, habitOrderByCategory])

  const total = habits.length
  const allDone = total > 0 && completedForActiveDate === total
  const progressPct =
    total === 0 ? 0 : Math.round((completedForActiveDate / total) * 100)

  const toggle = useCallback(
    (habitId: string) => {
      setData((s) => {
        const next: Persisted['completions'] = { ...s.completions }
        const day = { ...(next[activeLogDate] ?? {}) }
        if (day[habitId]) {
          delete day[habitId]
        } else {
          day[habitId] = true
        }
        let nextCompletions: Persisted['completions']
        if (Object.keys(day).length === 0) {
          nextCompletions = { ...next }
          delete nextCompletions[activeLogDate]
        } else {
          nextCompletions = { ...next, [activeLogDate]: day }
        }
        return { ...s, completions: nextCompletions }
      })
    },
    [activeLogDate],
  )

  const saveHabitModal = useCallback(() => {
    const name = draft.name.trim()
    const modal = habitModal
    if (!name || !modal) return
    const category = draft.category.trim() || 'Other'
    const color = isHexColor(draft.color) ? draft.color : COLOR_PRESETS[0]
    const icon = (EMOJI_ICONS as readonly string[]).includes(draft.icon)
      ? draft.icon
      : EMOJI_ICONS[0]

    setData((s) => {
      const preset = new Set(PRESET_CATEGORIES as readonly string[])
      let nextCustom = s.customCategories
      if (!preset.has(category) && !nextCustom.includes(category)) {
        nextCustom = [...nextCustom, category].sort((a, b) =>
          a.localeCompare(b),
        )
      }

      if (modal.mode === 'add') {
        const nextHabits = [
          ...s.habits,
          { id: crypto.randomUUID(), name, category, color, icon },
        ]
        return {
          ...s,
          customCategories: nextCustom,
          habits: nextHabits,
          habitOrderByCategory: sanitizeHabitOrderMap(
            nextHabits,
            s.habitOrderByCategory,
          ),
        }
      }
      const id = modal.id
      const nextHabits = s.habits.map((h) =>
        h.id === id ? { ...h, name, category, color, icon } : h,
      )
      return {
        ...s,
        customCategories: nextCustom,
        habits: nextHabits,
        habitOrderByCategory: sanitizeHabitOrderMap(
          nextHabits,
          s.habitOrderByCategory,
        ),
      }
    })
    setHabitModal(null)
  }, [draft, habitModal])

  const addCustomCategoryFromInput = useCallback(() => {
    const label = newCategoryInput.trim()
    if (!label) return
    const preset = PRESET_CATEGORIES as readonly string[]
    const matchPreset = preset.find(
      (p) => p.toLowerCase() === label.toLowerCase(),
    )
    if (matchPreset) {
      setDraft((d) => ({ ...d, category: matchPreset }))
      setNewCategoryInput('')
      return
    }
    setData((s) => {
      if (
        s.customCategories.some((c) => c.toLowerCase() === label.toLowerCase())
      ) {
        return s
      }
      return {
        ...s,
        customCategories: [...s.customCategories, label].sort((a, b) =>
          a.localeCompare(b),
        ),
      }
    })
    setDraft((d) => ({ ...d, category: label }))
    setNewCategoryInput('')
  }, [newCategoryInput])

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
      const nextHabits = s.habits.filter((h) => h.id !== id)
      return {
        habits: nextHabits,
        completions: nextCompletions,
        bestStreakByHabitId: nextBest,
        milestoneSeen: nextSeen,
        customCategories: s.customCategories,
        habitOrderByCategory: sanitizeHabitOrderMap(
          nextHabits,
          s.habitOrderByCategory,
        ),
      }
    })
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const onHabitDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const activeId = String(active.id)
    const overId = String(over.id)
    setData((s) => {
      const catA = findCategoryForHabitId(s.habits, activeId)
      const catO = findCategoryForHabitId(s.habits, overId)
      if (!catA || catA !== catO) return s
      const inCat = s.habits.filter(
        (h) => (h.category?.trim() || 'Other') === catA,
      )
      const ordered = mergeOrderWithHabits(
        catA,
        inCat,
        s.habitOrderByCategory,
      ).map((h) => h.id)
      const oldIndex = ordered.indexOf(activeId)
      const newIndex = ordered.indexOf(overId)
      if (oldIndex < 0 || newIndex < 0) return s
      const nextIds = arrayMove(ordered, oldIndex, newIndex)
      return {
        ...s,
        habitOrderByCategory: {
          ...s.habitOrderByCategory,
          [catA]: nextIds,
        },
      }
    })
  }, [])

  const categorySelectOptions = useMemo(() => {
    const s = new Set<string>(categoryOptions)
    const d = draft.category.trim()
    if (d) s.add(d)
    const arr = [...s]
    const preset = PRESET_CATEGORIES as readonly string[]
    arr.sort((a, b) => {
      const ap = preset.indexOf(a)
      const bp = preset.indexOf(b)
      if (ap !== -1 && bp !== -1) return ap - bp
      if (ap !== -1) return -1
      if (bp !== -1) return 1
      return a.localeCompare(b)
    })
    return arr
  }, [categoryOptions, draft.category])

  const headerDateLabel = useMemo(() => {
    const d =
      logView === 'yesterday' ? parseYMD(yesterdayYMD) : parseYMD(today)
    return d.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }, [logView, yesterdayYMD, today])

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
        <nav
          className="mb-6 flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/50 p-1"
          aria-label="Main navigation"
        >
          <button
            type="button"
            onClick={() => setAppTab('track')}
            className={[
              'min-h-10 flex-1 rounded-lg px-3 text-sm font-medium transition-colors',
              appTab === 'track'
                ? 'bg-zinc-100 text-zinc-900 shadow-sm'
                : 'text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200',
            ].join(' ')}
          >
            Track
          </button>
          <button
            type="button"
            onClick={() => setAppTab('stats')}
            className={[
              'min-h-10 flex-1 rounded-lg px-3 text-sm font-medium transition-colors',
              appTab === 'stats'
                ? 'bg-zinc-100 text-zinc-900 shadow-sm'
                : 'text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200',
            ].join(' ')}
          >
            Stats
          </button>
        </nav>

        {appTab === 'stats' ? (
          <HeatmapStatsView
            habits={habits}
            completions={completions}
            todayYMD={today}
          />
        ) : (
          <>
        <header className="mb-8 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium tracking-wide text-zinc-500">
                {headerDateLabel}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                {logView === 'yesterday' ? 'Yesterday' : 'Today'}
              </h1>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
              {logView === 'today' ? (
                <button
                  type="button"
                  onClick={() => setLogView('yesterday')}
                  className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-white"
                >
                  Log Yesterday
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setLogView('today')}
                  className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-white"
                >
                  Back to today
                </button>
              )}
            </div>
          </div>
          {logView === 'yesterday' && (
            <p className="text-xs text-zinc-500">
              Catch up on yesterday only — older dates stay read-only in this
              app.
            </p>
          )}
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
                    {completedForActiveDate}
                  </span>
                  <span className="text-zinc-500"> of </span>
                  <span className="font-medium text-zinc-200">{total}</span>
                  <span className="text-zinc-500">
                    {' '}
                    habits completed{' '}
                    {logView === 'yesterday' ? 'yesterday' : 'today'}
                  </span>
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
            aria-valuenow={completedForActiveDate}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-label={
              logView === 'yesterday'
                ? 'Habits completed yesterday'
                : 'Habits completed today'
            }
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
              {logView === 'yesterday'
                ? 'All done for yesterday'
                : 'All done for today'}
            </p>
            <p className="mt-1 text-sm text-emerald-400/90">
              {logView === 'yesterday'
                ? 'Nice — your streaks are updated.'
                : 'Nice work — see you tomorrow.'}
            </p>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onHabitDragEnd}
        >
          <div className="flex flex-1 flex-col gap-6">
            {habits.length === 0 ? (
              <p className="text-center text-sm text-zinc-500">
                No habits yet. Tap &quot;Add habit&quot; below.
              </p>
            ) : (
              habitsByCategory.map(({ category, habits: catHabits }) => (
                <section key={category}>
                  <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    <span
                      className="h-px min-w-[1rem] flex-1 bg-zinc-800"
                      aria-hidden
                    />
                    <span className="shrink-0">{category}</span>
                    <span
                      className="h-px min-w-[1rem] flex-1 bg-zinc-800"
                      aria-hidden
                    />
                  </h2>
                  <SortableContext
                    items={catHabits.map((h) => h.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <ul className="flex flex-col gap-3">
                      {catHabits.map((habit) => (
                        <SortableHabitRow
                          key={habit.id}
                          habit={habit}
                          logDate={activeLogDate}
                          dragDisabled={logView === 'yesterday'}
                          completions={completions}
                          habitRates={habitRates}
                          bestStreakByHabitId={bestStreakByHabitId}
                          onToggle={toggle}
                          onDelete={deleteHabit}
                          onEdit={(id) => setHabitModal({ mode: 'edit', id })}
                        />
                      ))}
                    </ul>
                  </SortableContext>
                </section>
              ))
            )}
          </div>
        </DndContext>

        <section className="mt-8 border-t border-zinc-800/80 pt-6">
          <button
            type="button"
            onClick={() => setHabitModal({ mode: 'add' })}
            className="min-h-11 w-full rounded-xl border border-zinc-600 bg-zinc-900 px-5 py-3 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
          >
            Add habit
          </button>
        </section>

          </>
        )}

        {habitModal && (
          <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/65 p-4 sm:items-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="habit-modal-title"
            onClick={() => setHabitModal(null)}
          >
            <div
              className="max-h-[min(90vh,540px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2
                id="habit-modal-title"
                className="text-lg font-semibold text-white"
              >
                {habitModal.mode === 'add' ? 'New habit' : 'Edit habit'}
              </h2>
              <div className="mt-4 flex flex-col gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Name
                  </span>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, name: e.target.value }))
                    }
                    placeholder="Habit name"
                    className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-zinc-100 placeholder:text-zinc-600 outline-none ring-emerald-500/30 focus:border-emerald-600/70 focus:ring-2"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Category
                  </span>
                  <select
                    value={
                      categorySelectOptions.includes(draft.category)
                        ? draft.category
                        : categorySelectOptions[0] ?? 'Other'
                    }
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, category: e.target.value }))
                    }
                    className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-zinc-100 outline-none focus:border-emerald-600/70 focus:ring-2 focus:ring-emerald-500/30"
                  >
                    {categorySelectOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Custom category
                  </span>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="text"
                      value={newCategoryInput}
                      onChange={(e) => setNewCategoryInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addCustomCategoryFromInput()
                        }
                      }}
                      placeholder="New category name"
                      className="min-h-11 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-emerald-600/70 focus:ring-2 focus:ring-emerald-500/30"
                    />
                    <button
                      type="button"
                      onClick={addCustomCategoryFromInput}
                      className="min-h-11 shrink-0 rounded-xl border border-zinc-600 bg-zinc-800 px-4 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
                    >
                      Add
                    </button>
                  </div>
                </div>
                <div>
                  <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Color
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {COLOR_PRESETS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={c}
                        onClick={() => setDraft((d) => ({ ...d, color: c }))}
                        className={[
                          'h-9 w-9 rounded-full border-2 transition-transform hover:scale-105',
                          draft.color === c
                            ? 'border-white ring-2 ring-white/30'
                            : 'border-transparent',
                        ].join(' ')}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Icon
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {EMOJI_ICONS.map((ic) => (
                      <button
                        key={ic}
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, icon: ic }))}
                        className={[
                          'flex h-10 w-10 items-center justify-center rounded-lg border text-lg transition-colors',
                          draft.icon === ic
                            ? 'border-emerald-500/80 bg-emerald-950/50'
                            : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600',
                        ].join(' ')}
                      >
                        {ic}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setHabitModal(null)}
                  className="min-h-11 rounded-xl border border-zinc-600 px-4 text-sm font-medium text-zinc-300 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveHabitModal}
                  className="min-h-11 rounded-xl bg-zinc-100 px-5 text-sm font-medium text-zinc-900 hover:bg-white"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
