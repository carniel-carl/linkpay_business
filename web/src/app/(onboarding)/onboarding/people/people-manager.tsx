"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { ArrowLeft, ArrowRight, CircleCheck, Pencil, Plus, Trash2, TriangleAlert, Users } from "lucide-react"
import { toast } from "sonner"
import { DocumentDropzone } from "@/components/onboarding/document-dropzone"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { ChecklistItem, KybDocument, Person } from "@/lib/api/types"
import { initials, maskBVN } from "@/lib/format"
import { ID_TYPE_LABELS, ROLE_LABELS } from "@/lib/kyb"
import { removePerson } from "../actions"
import { PersonForm } from "./person-form"

type Props = {
  people: Person[]
  documents: KybDocument[]
  checklist: ChecklistItem[]
  principal?: ChecklistItem
}

export function PeopleManager({ people, documents, checklist, principal }: Props) {
  const [editing, setEditing] = useState<Person | "new" | null>(null)
  const [removing, setRemoving] = useState<Person | null>(null)
  const [pending, startTransition] = useTransition()

  function confirmRemove() {
    if (!removing) return
    const person = removing
    startTransition(async () => {
      const result = await removePerson(person._id)
      setRemoving(null)
      if (result.ok) toast.success(`${person.fullName} removed.`)
      else toast.error(result.error)
    })
  }

  return (
    <div className="grid gap-6">
      {principal && (
        <p
          className={
            principal.done
              ? "flex items-center gap-2 text-sm text-muted-foreground"
              : "flex items-center gap-2 text-sm text-warning-foreground"
          }
        >
          {principal.done ? (
            <CircleCheck className="size-4 text-primary" aria-hidden />
          ) : (
            <TriangleAlert className="size-4" aria-hidden />
          )}
          {principal.done ? `Requirement met: ${lowerFirst(principal.label)}.` : `You need ${lowerFirst(principal.label)}.`}
        </p>
      )}

      {people.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No one added yet</EmptyTitle>
            <EmptyDescription>
              Start with yourself if you&apos;re an owner or director. You&apos;ll need each person&apos;s BVN and a photo ID.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setEditing("new")}>
              <Plus data-icon="inline-start" aria-hidden />
              Add a person
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <ul className="grid gap-3">
            {people.map((person) => (
              <PersonCard
                key={person._id}
                person={person}
                idDocument={documents.find((d) => d.person === person._id)}
                missing={checklist.filter((i) => i.key.startsWith(`person:${person._id}:`) && !i.done && !i.key.endsWith(":government_id"))}
                onEdit={() => setEditing(person)}
                onRemove={() => setRemoving(person)}
              />
            ))}
          </ul>
          <Button variant="outline" className="w-fit" onClick={() => setEditing("new")}>
            <Plus data-icon="inline-start" aria-hidden />
            Add another person
          </Button>
        </>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t pt-6">
        <Button variant="ghost" asChild>
          <Link href="/onboarding/details">
            <ArrowLeft data-icon="inline-start" aria-hidden />
            Back
          </Link>
        </Button>
        <Button asChild>
          <Link href="/onboarding/documents">
            Continue
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
      </div>

      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>{editing === "new" ? "Add a person" : "Edit person"}</SheetTitle>
            <SheetDescription>
              {editing === "new"
                ? "Use their details exactly as they appear on their ID."
                : "Leave the BVN blank to keep the one we have."}
            </SheetDescription>
          </SheetHeader>
          {editing !== null && (
            <PersonForm person={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.fullName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their details and uploaded ID will be deleted. You can add them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmRemove} disabled={pending}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PersonCard({
  person,
  idDocument,
  missing,
  onEdit,
  onRemove,
}: {
  person: Person
  idDocument?: KybDocument
  missing: ChecklistItem[]
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <li className="grid gap-4 surface p-4">
      <div className="flex items-start gap-3">
        <Avatar className="size-9">
          <AvatarFallback className="bg-muted text-xs font-medium">{initials(person.fullName)}</AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{person.fullName}</span>
            {person.roles.map((r) => (
              <Badge key={r} variant="outline">
                {ROLE_LABELS[r]}
              </Badge>
            ))}
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <div className="flex gap-1">
              <dt>BVN</dt>
              <dd className="font-mono text-foreground">{maskBVN(person.bvnLast4)}</dd>
            </div>
            <div className="flex gap-1">
              <dt>ID</dt>
              <dd className="text-foreground">{person.idType ? ID_TYPE_LABELS[person.idType] : "Not set"}</dd>
            </div>
            {person.ownershipPercent !== undefined && (
              <div className="flex gap-1">
                <dt>Owns</dt>
                <dd className="text-foreground figure">{person.ownershipPercent}%</dd>
              </div>
            )}
          </dl>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${person.fullName}`}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={`Remove ${person.fullName}`}>
            <Trash2 />
          </Button>
        </div>
      </div>

      {missing.length > 0 && (
        <p className="flex gap-2 text-sm text-warning-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          Missing {missing.map((m) => m.label.split(": ").pop()).join(" and ")}.{" "}
          <button type="button" onClick={onEdit} className="font-medium underline underline-offset-4">
            Add it
          </button>
        </p>
      )}

      <div className="grid gap-2 border-t pt-4">
        <p className="text-xs font-medium text-muted-foreground">
          {person.idType ? ID_TYPE_LABELS[person.idType] : "Government-issued photo ID"}
        </p>
        <DocumentDropzone
          compact
          type="government_id"
          personId={person._id}
          label={`${person.fullName}'s ID`}
          document={idDocument}
          description="Photo or scan of the front. PDF, PNG or JPEG, up to 5 MB."
        />
      </div>
    </li>
  )
}

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1)
}
