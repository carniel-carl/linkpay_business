import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { GateMessage, useBankingGate } from "@/components/home/gate";
import { PocketTile } from "@/components/savings/pocket-parts";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormError } from "@/components/ui/form-error";
import { Icon } from "@/components/ui/icon";
import { NairaField } from "@/components/ui/naira-field";
import { OptionList, OptionRow } from "@/components/ui/options";
import { Segmented } from "@/components/ui/segmented";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { can } from "@/lib/api/banking";
import { ApiError, fieldErrorsFrom, friendlyMessage } from "@/lib/api/errors";
import { usePocket, usePocketChange, type PocketInput } from "@/lib/api/savings";
import type { Branch, Pocket, PocketColor, PocketIcon } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatNaira } from "@/lib/format";
import { addDays, bpsToPercent, koboToInput, parsePercentToBps, todayInLagos } from "@/lib/invoices";
import { COLOR_LABELS, formatPercent, POCKET_COLORS, POCKET_ICON_KEYS, POCKET_ICONS, pocketTokens } from "@/lib/savings";
import { parseNaira } from "@/lib/send-draft";
import { useTheme } from "@/theme/theme";

const MAX_KOBO = 10_000_000_000;
type AutoMode = "off" | "percent" | "amount";

/** New pocket, or edit one (`?id=`). The branch is picked once, at creation. */
export default function PocketForm() {
  const { id, branch } = useLocalSearchParams<{ id?: string; branch?: string }>();
  const gate = useBankingGate();
  const pocket = usePocket(id);

  const loading = gate.state === "loading" || (!!id && !pocket.data);
  return (
    <>
      <Stack.Screen options={{ title: id ? "Edit pocket" : "New pocket" }} />
      {gate.state === "ready" && can(gate.overview, "savings.manage") && (!id || pocket.data) ? (
        <Form
          // A fresh form once the pocket arrives, so its fields start from the saved values.
          key={pocket.data?._id ?? "new"}
          pocket={pocket.data}
          branches={gate.overview.branches.filter((b) => b.account)}
          initialBranch={branch}
        />
      ) : (
        <KeyboardAwareScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-3 px-5 pt-6">
          <FocusStatusBar />
          {pocket.isError ? (
            <FormError message={friendlyMessage(pocket.error)} />
          ) : loading ? (
            <View className="h-40 rounded-surface bg-muted" />
          ) : gate.state !== "ready" ? (
            <GateMessage gate={gate} />
          ) : (
            <Text className="text-[15px] leading-[22px] text-muted-foreground">
              Your role doesn&apos;t include moving money into savings. Ask an owner or admin.
            </Text>
          )}
        </KeyboardAwareScrollView>
      )}
    </>
  );
}

function Form({ pocket, branches, initialBranch }: { pocket?: Pocket; branches: Branch[]; initialBranch?: string }) {
  const change = usePocketChange();
  const editing = !!pocket;
  const [name, setName] = useState(pocket?.name ?? "");
  const [icon, setIcon] = useState<PocketIcon>(pocket?.icon ?? "savings");
  const [color, setColor] = useState<PocketColor>(pocket?.color ?? "lime");
  const [branch, setBranch] = useState(
    pocket?.branch?._id ??
      (branches.some((b) => b._id === initialBranch) ? initialBranch : undefined) ??
      (branches.length === 1 ? branches[0]._id : undefined),
  );
  const [hasTarget, setHasTarget] = useState(!!pocket?.target);
  const [targetAmount, setTargetAmount] = useState(pocket?.target ? koboToInput(pocket.target.amountKobo) : "");
  const [hasDate, setHasDate] = useState(!!pocket?.target?.date);
  const [date, setDate] = useState(pocket?.target?.date ?? addDays(todayInLagos(), 90));
  const [mode, setMode] = useState<AutoMode>(
    pocket?.autoSave ? (pocket.autoSave.percentBps !== null ? "percent" : "amount") : "off",
  );
  const [percent, setPercent] = useState(
    pocket?.autoSave?.percentBps != null ? bpsToPercent(pocket.autoSave.percentBps) : "",
  );
  const [fixed, setFixed] = useState(pocket?.autoSave?.amountKobo != null ? koboToInput(pocket.autoSave.amountKobo) : "");
  const [submitted, setSubmitted] = useState(false);

  const tomorrow = addDays(todayInLagos(), 1);
  const targetKobo = parseNaira(targetAmount);
  const bps = parsePercentToBps(percent);
  const fixedKobo = parseNaira(fixed);
  const branchName = branches.find((b) => b._id === branch)?.name;

  // The server's own field errors (and a taken name) win over the local checks once it has answered.
  const server = change.error instanceof ApiError ? fieldErrorsFrom(change.error.details) : undefined;
  const nameTaken = change.error instanceof ApiError && change.error.code === "POCKET_NAME_TAKEN";
  const errors = {
    name: !name.trim() ? "Give the pocket a name." : server?.name,
    branch: !editing && !branch ? "Choose the branch whose money goes in it." : undefined,
    target: !hasTarget
      ? undefined
      : targetKobo === undefined || targetKobo < 100
        ? "Enter a target of at least ₦1."
        : targetKobo > MAX_KOBO
          ? "The largest target is ₦100,000,000."
          : undefined,
    // An unchanged date that has since passed may be kept; a new one must be in the future.
    date: hasTarget && hasDate && date < tomorrow && date !== pocket?.target?.date ? "Pick a date after today." : undefined,
    percent:
      mode === "percent" && (bps === null || bps < 100) ? "Enter a percentage from 1 to 100." : undefined,
    fixed:
      mode === "amount" && (fixedKobo === undefined || fixedKobo < 100 || fixedKobo > MAX_KOBO)
        ? "Enter an amount of at least ₦1."
        : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  function submit() {
    setSubmitted(true);
    if (invalid) return;
    const input: Omit<PocketInput, "branch"> = {
      name: name.trim(),
      icon,
      color,
      target: hasTarget ? { amountKobo: targetKobo!, date: hasDate ? date : null } : null,
      autoSave: mode === "percent" ? { percentBps: bps! } : mode === "amount" ? { amountKobo: fixedKobo! } : null,
    };
    const done = {
      onSuccess: (saved: Pocket) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (editing) router.back();
        else router.replace({ pathname: "/savings/[id]", params: { id: saved._id } });
      },
    };
    if (pocket) change.mutate({ kind: "update", id: pocket._id, input }, done);
    else change.mutate({ kind: "create", input: { ...input, branch: branch! } }, done);
  }

  const shown = (key: keyof typeof errors) => (submitted ? errors[key] : undefined);

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-7 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <View className="flex-row items-center gap-3 px-1">
        <PocketTile icon={icon} color={color} size={56} />
        <Text numberOfLines={2} className="flex-1 text-[17px] font-semibold text-foreground">
          {name.trim() || "Name your pocket"}
        </Text>
      </View>

      <FormError
        message={change.error && !nameTaken && !server ? friendlyMessage(change.error) : undefined}
      />

      <TextField
        label="Name"
        value={name}
        onChangeText={(v) => {
          setName(v.slice(0, 40));
          if (nameTaken) change.reset();
        }}
        placeholder="VAT and tax, Payroll, Rent"
        maxLength={40}
        autoCapitalize="sentences"
        error={nameTaken ? friendlyMessage(change.error) : shown("name")}
      />

      <IconPicker value={icon} onChange={setIcon} color={color} />
      <ColorPicker value={color} onChange={setColor} />

      {editing ? (
        <View className="gap-1 px-1">
          <Text className="text-[14px] font-medium text-foreground">Branch</Text>
          <Text className="text-[15px] text-muted-foreground">
            {pocket.branch?.name ?? "Branch removed"}. A pocket stays on the branch it was made in.
          </Text>
        </View>
      ) : (
        branches.length > 1 && (
          <OptionList
            label="Branch"
            hint="The pocket holds money from this branch's account. This can't change later."
            error={shown("branch")}
          >
            {branches.map((b) => (
              <OptionRow
                key={b._id}
                title={b.name}
                detail={b.isHeadOffice ? "Head office" : undefined}
                selected={branch === b._id}
                onPress={() => setBranch(b._id)}
              />
            ))}
          </OptionList>
        )
      )}

      <View className="gap-4">
        <SwitchRow
          title="Save towards a target"
          detail="See your progress, and get a notification when you reach it."
          value={hasTarget}
          onChange={setHasTarget}
        />
        {hasTarget && (
          <>
            <NairaField
              label="Target amount (₦)"
              value={targetAmount}
              onChangeText={setTargetAmount}
              error={shown("target")}
              hint={targetKobo && !errors.target ? formatNaira(targetKobo) : undefined}
              style={{ fontFamily: "BricolageText-SemiBold", fontSize: 20 }}
            />
            <SwitchRow title="Set a target date" value={hasDate} onChange={setHasDate} />
            {hasDate && (
              <DateField
                label="Reach it by"
                value={date}
                onChange={setDate}
                min={pocket?.target?.date && pocket.target.date < tomorrow ? pocket.target.date : tomorrow}
                error={shown("date")}
              />
            )}
          </>
        )}
      </View>

      <View className="gap-3">
        <Text className="text-[14px] font-medium text-foreground">Auto-save</Text>
        <Segmented
          label="Auto-save"
          segments={[
            { key: "off", label: "Off" },
            { key: "percent", label: "Percentage" },
            { key: "amount", label: "Fixed amount" },
          ]}
          value={mode}
          onChange={setMode}
        />
        {mode === "percent" && (
          <TextField
            label="Percentage of every payment in (%)"
            value={percent}
            onChangeText={(v) => setPercent(v.replace(/[^\d.]/g, "").slice(0, 6))}
            keyboardType="decimal-pad"
            placeholder="5"
            error={shown("percent")}
            hint={bps && !errors.percent ? `${formatPercent(bps)} of each payment` : undefined}
          />
        )}
        {mode === "amount" && (
          <NairaField
            label="Amount from every payment in (₦)"
            value={fixed}
            onChangeText={setFixed}
            error={shown("fixed")}
            hint={fixedKobo && !errors.fixed ? `${formatNaira(fixedKobo)}, or the whole payment if it's smaller` : undefined}
          />
        )}
        <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">
          {mode === "off"
            ? "Add money yourself whenever you like."
            : `Saved from each payment into ${branchName ?? "the branch"} from now on${hasTarget ? ", until the target is reached" : ""}. Payments from your other branches are skipped.`}
        </Text>
      </View>

      <Button loading={change.isPending} onPress={submit}>
        {editing ? "Save changes" : "Create pocket"}
      </Button>
    </KeyboardAwareScrollView>
  );
}

function SwitchRow({ title, detail, value, onChange }: { title: string; detail?: string; value: boolean; onChange: (v: boolean) => void }) {
  const { colors, shadows } = useTheme();
  return (
    <View style={{ boxShadow: shadows.surface }} className="min-h-14 flex-row items-center gap-3 rounded-surface bg-card px-4 py-3">
      <View className="flex-1 gap-0.5">
        <Text className="text-[15px] font-medium text-foreground">{title}</Text>
        {detail && <Text className="text-[13px] leading-[18px] text-muted-foreground">{detail}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.primary, false: colors.input }}
        accessibilityLabel={title}
      />
    </View>
  );
}

/** A grid of icons, five to a row. The selected one takes the pocket's colour, like the tile above. */
function IconPicker({ value, onChange, color }: { value: PocketIcon; onChange: (i: PocketIcon) => void; color: PocketColor }) {
  const { colors, shadows } = useTheme();
  const subtle = colors[pocketTokens(color).subtle];
  return (
    <View className="gap-2">
      <Text className="text-[14px] font-medium text-foreground">Icon</Text>
      <View style={{ boxShadow: shadows.surface }} className="flex-row flex-wrap rounded-surface bg-card p-2">
        {POCKET_ICON_KEYS.map((key) => {
          const selected = key === value;
          const glyph = POCKET_ICONS[key];
          return (
            <Pressable
              key={key}
              accessibilityRole="radio"
              accessibilityLabel={glyph.label}
              accessibilityState={{ checked: selected }}
              onPress={() => {
                void Haptics.selectionAsync();
                onChange(key);
              }}
              style={{ width: `${100 / 5}%` }}
              className="h-12 items-center justify-center"
            >
              <View
                style={selected ? { backgroundColor: subtle } : undefined}
                className={cn("h-11 w-11 items-center justify-center rounded-[13px]", selected && "border-[1.5px] border-primary")}
              >
                <Icon
                  ios={glyph.ios}
                  android={glyph.android}
                  size={20}
                  color={selected ? colors.foreground : colors["muted-foreground"]}
                />
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ColorPicker({ value, onChange }: { value: PocketColor; onChange: (c: PocketColor) => void }) {
  const { colors } = useTheme();
  return (
    <View className="gap-2">
      <Text className="text-[14px] font-medium text-foreground">Colour</Text>
      <View className="flex-row flex-wrap gap-2.5">
        {POCKET_COLORS.map((c) => {
          const selected = c === value;
          return (
            <Pressable
              key={c}
              accessibilityRole="radio"
              accessibilityLabel={COLOR_LABELS[c]}
              accessibilityState={{ checked: selected }}
              hitSlop={4}
              onPress={() => {
                void Haptics.selectionAsync();
                onChange(c);
              }}
              className={cn(
                "h-11 w-11 items-center justify-center rounded-full border-2",
                selected ? "border-primary" : "border-transparent",
              )}
            >
              <View style={{ backgroundColor: colors[pocketTokens(c).fill] }} className="h-8 w-8 items-center justify-center rounded-full">
                {selected && <Icon ios="checkmark" android="check" size={15} color={colors.card} />}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
