"use client";

import BottomSheetModal from "@/app/app/_components/bottom-sheet-modal";
import ButtonSpinner from "@/app/app/_components/button-spinner";
import { useFormActionFeedback } from "@/app/app/_components/use-form-action-feedback";
import type { RefObject } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import EntityCommentsBlock, {
  type EntityCommentDTO,
} from "../../_components/entity-comments-block";
import { useTripActiveTab } from "../../_lib/trip-active-tab-context";
import { useTripFabRegistry } from "../../_lib/trip-tab-fab-registry";
import { deleteExpenseAction, saveExpenseAction } from "../../data-actions";
import {
  computeExpenseSplit,
  previewLineForCurrentUser,
  type SplitType,
} from "../_lib/expense-split";
import { formatInr } from "../_lib/format-inr";

export type ExpenseCardDTO = {
  id: string;
  title: string;
  amount: number;
  paidBy: string;
  splitTypeRaw: string;
  dateLabel: string;
  dateInput: string;
  myShare: number;
  isPaidByYou: boolean;
  /** Who created the row in DB; null for legacy rows without user_id. */
  createdByUserId: string | null;
  /** Creator or trip organiser may update/delete. */
  canManage: boolean;
};

export type PaidByMemberOption = {
  userId: string;
  /** Stored in `expenses.paid_by` — profile / member display name. */
  label: string;
  email: string | null;
};

type TripExpensesClientProps = {
  tripId: string;
  tripTitle: string;
  defaultPaidBy: string;
  paidByMemberOptions: PaidByMemberOption[];
  memberCount: number;
  totalSpent: number;
  yourShareTotal: number;
  netBalance: number;
  expenses: ExpenseCardDTO[];
  initialError: string;
  currentUserId: string;
  memberLabelByUserId: Record<string, string>;
  expenseCommentsById: Record<string, EntityCommentDTO[]>;
  autoOpenAddExpense?: boolean;
  /** INR amount for the add-expense sheet (e.g. deep link from Forex). */
  prefillExpenseAmountInr?: number;
};
const QUICK_ACTION_EVENT = "travel-os-open-quick-action";

const LAST_SPLIT_KEY = "travel-os-last-expense-split-type";

function formatPrefillInrAmount(n: number): string {
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 100) / 100);
}

function normalizeUiSplitType(raw: string | null | undefined): SplitType {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "equal" || value === "exact" || value === "percentage" || value === "none") {
    return value;
  }
  if (value === "custom") return "exact";
  if (value === "full") return "none";
  return "equal";
}

function splitTypeLabel(raw: string) {
  const s = raw.toLowerCase();
  if (s === "equal") return "Equal";
  if (s === "full") return "Full amount";
  if (s === "none") return "None";
  if (s === "custom") return "Custom";
  return raw;
}

function useDismissOnOutsideClick(
  open: boolean,
  onClose: () => void,
  excludeRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (excludeRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [open, onClose, excludeRef]);
}

function IconDotsVertical({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <circle cx="12" cy="5" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="12" cy="19" r="1.75" />
    </svg>
  );
}

function ExpenseRowMenu({
  tripId,
  expenseId,
  onEdit,
}: {
  tripId: string;
  expenseId: string;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { pending: deletePending, runAction: runDeleteExpense } = useFormActionFeedback();
  useDismissOnOutsideClick(open, () => setOpen(false), wrapRef);

  return (
    <div className="relative shrink-0 self-start" ref={wrapRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
      >
        <span className="sr-only">Expense options</span>
        <IconDotsVertical />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-full z-40 mt-0.5 min-w-[9rem] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="flex min-h-11 w-full items-center px-4 text-left text-sm font-medium text-slate-800 hover:bg-slate-50"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            Update
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={deletePending}
            className="flex min-h-11 w-full items-center px-4 text-left text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
            onClick={() => {
              if (!window.confirm("Delete this expense? This cannot be undone.")) {
                return;
              }
              setOpen(false);
              runDeleteExpense(() =>
                deleteExpenseAction(tripId, expenseId, new FormData()),
              );
            }}
          >
            {deletePending ? "Deleting…" : "Delete"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function isoDateLocal(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resolvePaidBySelectDefault(
  editing: ExpenseCardDTO | null,
  defaultPaidBy: string,
  options: PaidByMemberOption[],
): string {
  if (!editing) return defaultPaidBy;
  const stored = editing.paidBy.trim();
  if (!stored) return defaultPaidBy;

  const byLabel = options.find((o) => o.label === stored);
  if (byLabel) return byLabel.label;

  const byUserId = options.find((o) => o.userId === stored);
  if (byUserId) return byUserId.label;

  const lower = stored.toLowerCase();
  for (const o of options) {
    const em = o.email?.trim();
    if (!em) continue;
    if (em.toLowerCase() === lower) return o.label;
    const local = em.split("@")[0]?.toLowerCase();
    if (local && local === lower) return o.label;
  }

  return stored;
}

function ExpenseFormSheet({
  open,
  onClose,
  tripId,
  formKey,
  editing,
  defaultPaidBy,
  paidByMemberOptions,
  prefillAmountInr,
}: {
  open: boolean;
  onClose: () => void;
  tripId: string;
  formKey: string;
  editing: ExpenseCardDTO | null;
  defaultPaidBy: string;
  paidByMemberOptions: PaidByMemberOption[];
  prefillAmountInr: number | null;
}) {
  const saveAction = useCallback((fd: FormData) => saveExpenseAction(tripId, fd), [tripId]);
  const { pending, handleForm } = useFormActionFeedback();

  const titleDefault = editing?.title ?? "";
  const amountDefault =
    editing != null
      ? String(editing.amount)
      : prefillAmountInr != null && Number.isFinite(prefillAmountInr)
        ? formatPrefillInrAmount(prefillAmountInr)
        : "";
  const paidByDefault = resolvePaidBySelectDefault(editing, defaultPaidBy, paidByMemberOptions);
  const [splitType, setSplitType] = useState<SplitType>(
    normalizeUiSplitType(editing?.splitTypeRaw),
  );
  const dateDefault = editing?.dateInput?.trim() || isoDateLocal(new Date());
  const [amountInput, setAmountInput] = useState(amountDefault);
  const [descriptionInput, setDescriptionInput] = useState(titleDefault);
  const [paidByUserId, setPaidByUserId] = useState(
    paidByMemberOptions.find((o) => o.label === paidByDefault)?.userId ??
      paidByMemberOptions[0]?.userId ??
      "",
  );
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>(
    paidByMemberOptions.map((o) => o.userId),
  );
  const [includePayer, setIncludePayer] = useState(true);
  const [exactAmounts, setExactAmounts] = useState<Record<string, number>>({});
  const [percentages, setPercentages] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      const allIds = paidByMemberOptions.map((o) => o.userId);
      const fallbackUserId =
        paidByMemberOptions.find((o) => o.label === paidByDefault)?.userId ??
        paidByMemberOptions[0]?.userId ??
        "";
      setAmountInput(amountDefault);
      setDescriptionInput(titleDefault);
      setPaidByUserId(fallbackUserId);
      setSelectedParticipantIds(allIds);
      setIncludePayer(true);
      setExactAmounts(
        Object.fromEntries(
          allIds.map((id) => [id, id === fallbackUserId ? Number(amountDefault || 0) : 0]),
        ),
      );
      setPercentages(
        Object.fromEntries(
          allIds.map((id) => [id, allIds.length > 0 ? Number((100 / allIds.length).toFixed(2)) : 0]),
        ),
      );
      if (editing?.splitTypeRaw) {
        setSplitType(normalizeUiSplitType(editing.splitTypeRaw));
        return;
      }
      try {
        const remembered = localStorage.getItem(LAST_SPLIT_KEY);
        if (remembered === "equal" || remembered === "exact" || remembered === "percentage" || remembered === "none") {
          setSplitType(remembered);
        } else {
          setSplitType("equal");
        }
      } catch {
        setSplitType("equal");
      }
    });
  }, [open, editing, amountDefault, titleDefault, paidByMemberOptions, paidByDefault, prefillAmountInr]);

  useEffect(() => {
    try {
      localStorage.setItem(LAST_SPLIT_KEY, splitType);
    } catch {
      /* ignore */
    }
  }, [splitType]);

  useEffect(() => {
    if (splitType !== "equal") return;
    const targetIds = includePayer
      ? selectedParticipantIds
      : selectedParticipantIds.filter((id) => id !== paidByUserId);
    if (targetIds.length === 0) return;
    const share = Number(amountInput || 0) / targetIds.length;
    const nextExact: Record<string, number> = {};
    for (const id of selectedParticipantIds) {
      nextExact[id] = targetIds.includes(id) ? Number(share.toFixed(2)) : 0;
    }
    queueMicrotask(() => setExactAmounts(nextExact));
  }, [splitType, includePayer, selectedParticipantIds, paidByUserId, amountInput]);

  const amountNumber = Number(amountInput || 0);
  const computed = useMemo(
    () =>
      computeExpenseSplit({
        amount: amountNumber,
        splitType,
        paidByUserId,
        selectedParticipantIds,
        includePayerInEqual: includePayer,
        exactAmountsByUserId: exactAmounts,
        percentagesByUserId: percentages,
      }),
    [amountNumber, splitType, paidByUserId, selectedParticipantIds, includePayer, exactAmounts, percentages],
  );

  const hasInlineError = computed.errors.length > 0;

  return (
    <BottomSheetModal
      open={open}
      onClose={onClose}
      title={editing ? "Update expense" : "Add expense"}
      description="Split trip costs fairly with your group."
      panelClassName="max-h-[72vh]"
      titleId="expense-sheet-title"
    >
      <form
        key={formKey}
        onSubmit={(e) => {
          return handleForm(e, saveAction, onClose);
        }}
        className="flex flex-col gap-4 pb-20"
      >
        {editing ? <input type="hidden" name="expenseId" value={editing.id} /> : null}
        <input type="hidden" name="splitType" value={splitType} />
        <input type="hidden" name="paidBy" value={paidByUserId} />
        <input type="hidden" name="participantIdsJson" value={JSON.stringify(selectedParticipantIds)} />
        <input type="hidden" name="exactAmountsJson" value={JSON.stringify(exactAmounts)} />
        <input type="hidden" name="percentagesJson" value={JSON.stringify(percentages)} />
        <input type="hidden" name="includePayer" value={String(includePayer)} />

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Amount (INR)</span>
          <input
            name="amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            required
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0"
            className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-2.5 text-base text-slate-900 outline-none focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-900/10"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Description (optional)</span>
          <input
            name="description"
            value={descriptionInput}
            onChange={(e) => setDescriptionInput(e.target.value)}
            placeholder="e.g. Dinner at cafe"
            className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-2.5 text-base text-slate-900 outline-none focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-900/10"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Paid by</span>
          <select
            required
            value={paidByUserId}
            onChange={(e) => setPaidByUserId(e.target.value)}
            className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-2.5 text-base text-slate-900 outline-none focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-900/10"
          >
            {paidByMemberOptions.map((o) => (
              <option key={o.userId} value={o.userId}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Participants</p>
          <div className="grid grid-cols-1 gap-2">
            {paidByMemberOptions.map((o) => {
              const checked = selectedParticipantIds.includes(o.userId);
              return (
                <label key={o.userId} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      setSelectedParticipantIds((prev) =>
                        e.target.checked ? [...new Set([...prev, o.userId])] : prev.filter((id) => id !== o.userId),
                      );
                    }}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  <span className="text-sm text-slate-800">{o.label}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Split type</p>
          <div className="grid grid-cols-2 gap-2">
            {(["equal", "exact", "percentage", "none"] as SplitType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setSplitType(type)}
                className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${
                  splitType === type
                    ? "bg-slate-900 text-white"
                    : "border border-slate-200 bg-white text-slate-700"
                }`}
              >
                {type === "none"
                  ? "Paid by me only"
                  : type === "percentage"
                    ? "Percentage"
                    : type === "exact"
                      ? "Exact amount"
                      : "Equal"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setSplitType("equal");
              setIncludePayer(true);
            }}
            className="inline-flex min-h-9 items-center rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-700"
          >
            Split equally (quick action)
          </button>
        </div>

        {splitType === "equal" ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={includePayer}
                onChange={(e) => setIncludePayer(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Include payer in equal split
            </label>
          </div>
        ) : null}

        {splitType === "exact" ? (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
            {selectedParticipantIds.map((id) => {
              const label = paidByMemberOptions.find((o) => o.userId === id)?.label ?? id;
              return (
                <label key={id} className="block">
                  <span className="text-xs font-medium text-slate-600">{label}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={String(exactAmounts[id] ?? 0)}
                    onChange={(e) =>
                      setExactAmounts((prev) => ({ ...prev, [id]: Number(e.target.value || 0) }))
                    }
                    className="mt-1 min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800"
                  />
                </label>
              );
            })}
            <p className="text-xs text-slate-600">Remaining: INR {computed.remainingAmount.toFixed(2)}</p>
          </div>
        ) : null}

        {splitType === "percentage" ? (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
            {selectedParticipantIds.map((id) => {
              const label = paidByMemberOptions.find((o) => o.userId === id)?.label ?? id;
              return (
                <label key={id} className="block">
                  <span className="text-xs font-medium text-slate-600">{label} (%)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={String(percentages[id] ?? 0)}
                    onChange={(e) =>
                      setPercentages((prev) => ({ ...prev, [id]: Number(e.target.value || 0) }))
                    }
                    className="mt-1 min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800"
                  />
                </label>
              );
            })}
            <p className="text-xs text-slate-600">Remaining: {computed.remainingPercentage.toFixed(2)}%</p>
          </div>
        ) : null}

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Date</span>
          <input
            name="date"
            type="date"
            required
            defaultValue={dateDefault}
            className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-2.5 text-base text-slate-900 outline-none focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-900/10"
          />
        </label>

        <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Settlement preview</p>
          <ul className="space-y-1.5">
            {computed.rows.map((row) => {
              const label = paidByMemberOptions.find((o) => o.userId === row.userId)?.label ?? row.userId;
              const amt = Math.abs(row.owesAmount).toFixed(2);
              return (
                <li key={row.userId} className="text-sm text-slate-700">
                  {row.owesAmount > 0
                    ? `${label} owes INR ${amt}`
                    : row.owesAmount < 0
                      ? `${label} gets INR ${amt}`
                      : `${label} is settled`}
                </li>
              );
            })}
          </ul>
          <p className="text-sm font-semibold text-slate-900">
            {previewLineForCurrentUser(computed.rows, "")}
          </p>
          {hasInlineError ? (
            <p className="text-xs font-medium text-rose-700">{computed.errors[0]}</p>
          ) : null}
        </section>

        <div className="sticky bottom-0 z-10 -mx-1 mt-2 flex gap-3 border-t border-slate-100 bg-white/95 px-1 pt-3 backdrop-blur">
          <button
            type="submit"
            disabled={pending || hasInlineError}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-900 py-3 text-base font-medium text-white shadow-md shadow-slate-900/20 disabled:opacity-60"
          >
            {pending ? (
              <>
                <ButtonSpinner className="h-4 w-4 text-white" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="min-h-11 flex-1 rounded-xl border border-slate-200 bg-white py-3 text-base font-medium text-slate-800 shadow-sm active:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </BottomSheetModal>
  );
}

export default function TripExpensesClient({
  tripId,
  defaultPaidBy,
  paidByMemberOptions,
  memberCount,
  totalSpent,
  yourShareTotal,
  netBalance,
  expenses,
  initialError,
  currentUserId,
  memberLabelByUserId,
  expenseCommentsById,
  autoOpenAddExpense = false,
  prefillExpenseAmountInr,
}: TripExpensesClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTripTab = useTripActiveTab();
  const { setOpenExpense } = useTripFabRegistry();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseCardDTO | null>(null);
  const formKeySeq = useRef(0);
  const [formKey, setFormKey] = useState("expense-new-0");
  const [prefillDraftInr, setPrefillDraftInr] = useState<number | null>(() =>
    prefillExpenseAmountInr != null && Number.isFinite(prefillExpenseAmountInr)
      ? prefillExpenseAmountInr
      : null,
  );
  const strippedExpenseQueryRef = useRef(false);

  useEffect(() => {
    if (prefillExpenseAmountInr != null && Number.isFinite(prefillExpenseAmountInr)) {
      queueMicrotask(() => setPrefillDraftInr(prefillExpenseAmountInr));
    }
  }, [prefillExpenseAmountInr]);

  const openAdd = useCallback(() => {
    formKeySeq.current += 1;
    setEditing(null);
    setFormKey(`expense-new-${formKeySeq.current}`);
    setSheetOpen(true);
  }, []);

  useEffect(() => {
    setOpenExpense(openAdd);
    return () => setOpenExpense(null);
  }, [setOpenExpense, openAdd]);

  useEffect(() => {
    if (activeTripTab !== "expenses" || !autoOpenAddExpense) return;
    queueMicrotask(() => openAdd());
  }, [activeTripTab, autoOpenAddExpense, openAdd]);

  useEffect(() => {
    if (strippedExpenseQueryRef.current) return;
    if (searchParams.get("quickAction") !== "expense" && !searchParams.get("prefillExpenseInr")) {
      return;
    }
    strippedExpenseQueryRef.current = true;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("quickAction");
    next.delete("prefillExpenseInr");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  useEffect(() => {
    const onQuickAction = (event: Event) => {
      if (activeTripTab !== "expenses") return;
      const detail = (event as CustomEvent<{ action?: string }>).detail;
      if (detail?.action === "expense") openAdd();
    };
    window.addEventListener(QUICK_ACTION_EVENT, onQuickAction as EventListener);
    return () => window.removeEventListener(QUICK_ACTION_EVENT, onQuickAction as EventListener);
  }, [activeTripTab, openAdd]);

  useEffect(() => {
    if (activeTripTab !== "expenses") {
      queueMicrotask(() => {
        setSheetOpen(false);
        setEditing(null);
      });
    }
  }, [activeTripTab]);

  const openEdit = (row: ExpenseCardDTO) => {
    formKeySeq.current += 1;
    setEditing(row);
    setFormKey(`expense-edit-${row.id}-${formKeySeq.current}`);
    setSheetOpen(true);
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setEditing(null);
    setPrefillDraftInr(null);
  };

  return (
    <>
      <section className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 shadow-sm">
        <p className="text-sm font-semibold text-indigo-900">Track group costs and settle faster</p>
        <p className="mt-1 text-xs leading-relaxed text-indigo-800">
          Add each expense, split it fairly, and see who owes or gets paid so money conversations stay clear.
        </p>
        <p className="mt-3 text-xs leading-relaxed text-indigo-800">
          <Link
            href={`/app/trip/${tripId}?tab=connect`}
            className="font-semibold text-indigo-950 underline decoration-indigo-400/80 underline-offset-2 hover:text-indigo-900"
          >
            Open Connect
          </Link>{" "}
          to chat, share docs, or check members while you sort out costs.
        </p>
      </section>

      {initialError ? (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{initialError}</p>
      ) : null}

      <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Summary</h2>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-slate-100 bg-slate-50/80 p-4 shadow-sm">
            <p className="flex items-center gap-2 text-sm text-slate-600">
              <span className="text-lg" aria-hidden>
                💰
              </span>
              Total spent
            </p>
            <p className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
              {formatInr(totalSpent)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50/80 p-4 shadow-sm">
            <p className="flex items-center gap-2 text-sm text-slate-600">
              <span className="text-lg" aria-hidden>
                👤
              </span>
              Your share
            </p>
            <p className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
              {formatInr(yourShareTotal)}
            </p>
          </div>
        </div>

        <div
          className={`mt-4 rounded-2xl px-4 py-3.5 text-sm font-semibold ${
            netBalance < 0
              ? "bg-rose-50 text-rose-700 ring-1 ring-rose-100"
              : netBalance > 0
                ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100"
                : "bg-slate-100 text-slate-600 ring-1 ring-slate-200/80"
          }`}
        >
          {netBalance < 0 && <>You owe {formatInr(Math.abs(netBalance))}</>}
          {netBalance > 0 && <>You are owed {formatInr(netBalance)}</>}
          {netBalance === 0 && <>You are all settled up</>}
        </div>
      </section>

      <section className="mt-4 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">All expenses</h2>

        {expenses.length === 0 ? (
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
            <div className="rounded-2xl bg-slate-100 p-5 text-3xl" aria-hidden>
              🧾
            </div>
            <p className="mt-5 text-base font-semibold text-slate-900">No expenses added yet</p>
            <p className="mt-2 max-w-[260px] text-sm leading-relaxed text-slate-600">
              Start tracking your trip expenses
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {expenses.map((row) => (
              <li key={row.id}>
                <div className="relative overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-sm shadow-slate-900/5">
                  <div className="flex p-4">
                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-base font-semibold text-slate-900">{row.title}</p>
                          <p className="mt-1 text-lg font-bold tracking-tight text-slate-900">
                            {formatInr(row.amount)}
                          </p>
                        </div>
                        {row.isPaidByYou ? (
                          <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-800 ring-1 ring-indigo-100">
                            You paid
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-100">
                            Paid by {row.paidBy}
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-medium text-slate-700">
                        Your share:{" "}
                        <span className="text-slate-900">{formatInr(row.myShare)}</span>
                      </p>
                      <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-700">
                          Split: {splitTypeLabel(row.splitTypeRaw)}
                        </span>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-700">
                          {row.dateLabel || "No date"}
                        </span>
                        {memberCount > 0 ? (
                          <span className="rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-500">
                            {memberCount} splitting
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {row.canManage ? (
                      <ExpenseRowMenu tripId={tripId} expenseId={row.id} onEdit={() => openEdit(row)} />
                    ) : null}
                  </div>
                  <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3">
                    <EntityCommentsBlock
                      tripId={tripId}
                      entityType="expense"
                      entityId={row.id}
                      currentUserId={currentUserId}
                      initialComments={expenseCommentsById[row.id] ?? []}
                      memberLabelByUserId={memberLabelByUserId}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ExpenseFormSheet
        open={sheetOpen}
        onClose={closeSheet}
        tripId={tripId}
        formKey={formKey}
        editing={editing}
        defaultPaidBy={defaultPaidBy}
        paidByMemberOptions={paidByMemberOptions}
        prefillAmountInr={editing ? null : prefillDraftInr}
      />
    </>
  );
}
