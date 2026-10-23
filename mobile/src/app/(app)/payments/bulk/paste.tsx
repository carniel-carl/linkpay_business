import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { FocusStatusBar } from "@/components/ui/status-bar";
import { TextField } from "@/components/ui/text-field";
import { friendlyMessage } from "@/lib/api/errors";
import { useBanks } from "@/lib/api/transfers";
import { CSV_EXAMPLE, MAX_BULK_ROWS, MAX_CSV_BYTES, parseCsv } from "@/lib/bulk-csv";
import { useBulkDraft } from "@/lib/bulk-draft";
import { discardFile } from "@/lib/document-file";
import { formatNaira } from "@/lib/format";
import { useTheme } from "@/theme/theme";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });
/** How many problem lines to list before "and N more". */
const SHOWN = 5;

/**
 * Rows pasted from a spreadsheet, or read from a CSV file, in the web's format. Lines that need fixing are
 * added too, marked, so they can be fixed one by one on the list rather than in a small text box.
 */
export default function BulkPaste() {
  const { shadows } = useTheme();
  const banks = useBanks();
  const existing = useBulkDraft((s) => s.rows.length);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const parsed = useMemo(() => (banks.data ? parseCsv(text, banks.data) : []), [text, banks.data]);
  const bad = parsed.filter((r) => r.error);
  const totalKobo = parsed.reduce((s, r) => s + (r.amountKobo ?? 0), 0);
  const over = existing + parsed.length > MAX_BULK_ROWS;

  async function paste() {
    try {
      const copied = await Clipboard.getStringAsync();
      if (!copied.trim()) return setError("There's nothing to paste. Copy the rows from your spreadsheet first.");
      setText(copied);
      setError(undefined);
    } catch {
      setError("We couldn't read what you copied. Paste it into the box instead.");
    }
  }

  async function chooseFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["text/csv", "text/comma-separated-values", "application/csv", "text/plain"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = !result.canceled ? result.assets[0] : undefined;
    if (!asset) return;
    try {
      const file = new File(asset.uri);
      if ((asset.size ?? file.size) > MAX_CSV_BYTES) return setError("That file is too big. Keep it under 500 KB (about 200 rows).");
      setText(await file.text());
      setError(undefined);
    } catch {
      setError("We couldn't read that file. Save it from your spreadsheet as CSV and try again.");
    } finally {
      discardFile(asset.uri);
    }
  }

  function add() {
    if (!parsed.length) return setError("Paste at least one row.");
    if (over) {
      return setError(
        `That's ${existing + parsed.length} people with the ${existing} already on the list. A bulk transfer can pay up to ${MAX_BULK_ROWS}.`,
      );
    }
    useBulkDraft.getState().addRows(
      parsed.map((r) => ({
        accountNumber: r.accountNumber,
        bank: r.bank,
        bankText: r.bank ? undefined : r.bankText,
        bankError: r.bankError,
        amountKobo: r.amountKobo,
        narration: r.narration,
        line: r.line,
      })),
    );
    router.back();
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-5 px-4 pb-12 pt-4"
    >
      <FocusStatusBar />
      <View className="gap-2 px-1">
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          One person per line: account number, bank name or code, amount in naira, then an optional narration. A header row is fine.
        </Text>
        <View style={{ boxShadow: shadows.surface }} className="rounded-field bg-card px-4 py-3">
          <Text selectable style={{ fontFamily: MONO, fontSize: 12, lineHeight: 18 }} className="text-foreground">
            {CSV_EXAMPLE}
          </Text>
        </View>
      </View>

      <View className="flex-row gap-3">
        <Button variant="outline" size="md" className="flex-1" icon={{ ios: "doc.on.clipboard", android: "content_paste" }} onPress={() => void paste()}>
          Paste
        </Button>
        <Button variant="outline" size="md" className="flex-1" icon={{ ios: "doc", android: "upload_file" }} onPress={() => void chooseFile()}>
          Choose a file
        </Button>
      </View>

      <TextField
        label="Rows"
        value={text}
        onChangeText={(v) => {
          setText(v);
          setError(undefined);
        }}
        multiline
        placeholder={CSV_EXAMPLE}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        textContentType="none"
        style={{ minHeight: 168, maxHeight: 320, paddingTop: 12, paddingBottom: 12, textAlignVertical: "top", fontFamily: MONO, fontSize: 13 }}
      />

      {banks.isError ? (
        <View className="gap-3">
          <FormError message={friendlyMessage(banks.error)} />
          <Button variant="outline" onPress={() => void banks.refetch()}>
            Try again
          </Button>
        </View>
      ) : banks.isPending && text.trim() ? (
        <Text className="px-1 text-[14px] text-muted-foreground">Loading the list of banks…</Text>
      ) : parsed.length > 0 ? (
        <View className="gap-1.5 px-1">
          <Text className="text-[14px] font-medium text-foreground">
            {parsed.length} {parsed.length === 1 ? "person" : "people"}, {formatNaira(totalKobo)} before fees
          </Text>
          {bad.length > 0 && (
            <>
              <Text className="text-[14px] leading-5 text-destructive-foreground">
                {bad.length} {bad.length === 1 ? "line needs" : "lines need"} fixing. {bad.length === 1 ? "It's" : "They're"} added too, marked, so you can fix{" "}
                {bad.length === 1 ? "it" : "them"} on the list:
              </Text>
              {bad.slice(0, SHOWN).map((r) => (
                <Text key={r.line} className="text-[13px] leading-[18px] text-destructive-foreground">
                  Line {r.line}: {r.error}
                </Text>
              ))}
              {bad.length > SHOWN && <Text className="text-[13px] text-destructive-foreground">and {bad.length - SHOWN} more.</Text>}
            </>
          )}
        </View>
      ) : null}

      <FormError message={error} />
      <Button disabled={!parsed.length} onPress={add}>
        {parsed.length ? `Add ${parsed.length} ${parsed.length === 1 ? "person" : "people"}` : "Add"}
      </Button>
    </KeyboardAwareScrollView>
  );
}
