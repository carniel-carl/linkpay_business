import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Linking, Platform, Pressable, Text, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { useOnboarding } from "@/lib/api/onboarding";
import { friendlyMessage } from "@/lib/api/errors";
import type { KybDocument } from "@/lib/api/types";
import { discardFile, pickDocument, type DocumentSource } from "@/lib/document-file";
import { cn } from "@/lib/cn";
import type { DocumentType } from "@/lib/kyb";
import { useTheme } from "@/theme/theme";

const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function statusLine(doc?: KybDocument) {
  if (!doc) return { text: "Not uploaded yet", tone: "muted" as const };
  if (doc.status === "accepted") return { text: "Accepted", tone: "success" as const };
  if (doc.status === "rejected") return { text: "Needs a new file", tone: "warning" as const };
  return { text: `Uploaded · ${formatSize(doc.size)}`, tone: "muted" as const };
}

/**
 * One required document: what's on file and a way to add or replace it. Adding offers the camera, the
 * photo library and Files; photos are converted to JPEG before upload (see lib/document-file.ts).
 */
export function DocumentSlot({
  type,
  personId,
  label,
  hint,
  document: doc,
  editable = true,
}: {
  type: DocumentType;
  personId?: string;
  label: string;
  hint?: string;
  document?: KybDocument;
  editable?: boolean;
}) {
  const { colors } = useTheme();
  const save = useOnboarding();
  const [busy, setBusy] = useState<"upload" | "remove">();
  const [error, setError] = useState<string>();
  const status = statusLine(doc);
  // An accepted document stays: the reviewer has already checked it.
  const canChange = editable && doc?.status !== "accepted";

  async function upload(source: DocumentSource) {
    setError(undefined);
    const picked = await pickDocument(source);
    if (!picked.ok) {
      if (picked.reason === "denied") {
        Alert.alert("Camera access is off", picked.message, [
          { text: "Not now", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ]);
      } else if (picked.reason === "invalid") setError(picked.message);
      return;
    }
    setBusy("upload");
    try {
      await save.mutateAsync({ kind: "upload", type, personId, file: picked.file });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      discardFile(picked.file.uri);
      setBusy(undefined);
    }
  }

  function remove() {
    if (!doc) return;
    Alert.alert(`Remove ${label}?`, "You'll need to upload it again before you submit.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setBusy("remove");
          setError(undefined);
          try {
            await save.mutateAsync({ kind: "removeDocument", id: doc._id });
          } catch (err) {
            setError(friendlyMessage(err));
          } finally {
            setBusy(undefined);
          }
        },
      },
    ]);
  }

  function choose() {
    const title = doc ? `Replace ${label}` : label;
    if (Platform.OS === "ios") {
      const options = ["Take a photo", "Choose from photos", "Choose a file", ...(doc ? ["Remove"] : []), "Cancel"];
      ActionSheetIOS.showActionSheetWithOptions(
        { title, options, cancelButtonIndex: options.length - 1, destructiveButtonIndex: doc ? 3 : undefined },
        (i) => {
          if (i === 0) void upload("camera");
          else if (i === 1) void upload("photos");
          else if (i === 2) void upload("files");
          else if (doc && i === 3) remove();
        },
      );
      return;
    }
    // Android dialogs hold three buttons; Files also shows the gallery there.
    Alert.alert(
      title,
      undefined,
      [
        { text: "Take a photo", onPress: () => void upload("camera") },
        { text: "Choose a file", onPress: () => void upload("files") },
        doc ? { text: "Remove", style: "destructive", onPress: remove } : { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole={canChange ? "button" : undefined}
        accessibilityLabel={`${label}. ${status.text}`}
        accessibilityHint={canChange ? (doc ? "Replace or remove this document" : "Take a photo or choose a file") : undefined}
        disabled={!canChange || !!busy}
        onPress={choose}
        className={cn(
          "min-h-[64px] flex-row items-center gap-3 rounded-field border-[1.5px] bg-card px-4 py-3 active:opacity-80",
          doc?.status === "rejected" || error ? "border-destructive" : doc ? "border-input" : "border-dashed border-input",
        )}
      >
        <View
          className={cn(
            "h-10 w-10 items-center justify-center rounded-[12px]",
            status.tone === "success" ? "bg-success-subtle" : status.tone === "warning" ? "bg-warning-subtle" : "bg-brand-subtle",
          )}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Icon
              ios={doc?.status === "accepted" ? "checkmark.seal.fill" : doc ? "doc.text.fill" : "doc.badge.plus"}
              android={doc?.status === "accepted" ? "verified" : doc ? "description" : "note_add"}
              size={20}
              color={status.tone === "success" ? colors["success-foreground"] : status.tone === "warning" ? colors["warning-foreground"] : colors.primary}
            />
          )}
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-medium leading-5 text-foreground">{label}</Text>
          <Text
            numberOfLines={1}
            className={cn(
              "text-[13px]",
              status.tone === "success" ? "text-success-foreground" : status.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {busy === "upload" ? "Uploading…" : busy === "remove" ? "Removing…" : status.text}
          </Text>
        </View>
        {canChange && !busy && <Text className="text-[14px] font-semibold text-primary">{doc ? "Replace" : "Add"}</Text>}
      </Pressable>
      {doc?.status === "rejected" && doc.rejectionReason && (
        <Text className="px-1 text-[13px] leading-[18px] text-warning-foreground">Reviewer note: {doc.rejectionReason}</Text>
      )}
      {error ? (
        <Text accessibilityLiveRegion="polite" className="px-1 text-[13px] leading-[18px] text-destructive-foreground">
          {error}
        </Text>
      ) : hint && !doc ? (
        <Text className="px-1 text-[13px] leading-[18px] text-muted-foreground">{hint}</Text>
      ) : null}
    </View>
  );
}
