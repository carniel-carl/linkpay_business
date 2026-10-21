"use client"

import Link from "next/link"
import { useTheme } from "next-themes"
import { LogOut, Monitor, Moon, Settings, Sun } from "lucide-react"
import { signOut } from "@/app/(auth)/actions"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { User } from "@/lib/api/types"
import { initials } from "@/lib/format"

export function UserMenu({
  user,
  showSettings = true,
  tone = "paper",
}: {
  user: Pick<User, "name" | "email">
  showSettings?: boolean
  /** "ink" when the trigger sits on the dark brand surface. */
  tone?: "paper" | "ink"
}) {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={tone === "ink" ? "hover:bg-brand-surface-foreground/10" : undefined}
          aria-label="Account menu"
        >
          <Avatar className="size-8 after:hidden">
            <AvatarFallback
              className={
                tone === "ink"
                  ? "bg-pop font-display text-xs font-semibold text-pop-foreground"
                  : "bg-brand-subtle font-display text-xs font-semibold text-primary"
              }
            >
              {initials(user.name)}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="grid gap-0.5 font-normal">
          <span className="truncate text-sm font-medium text-foreground">{user.name}</span>
          <span className="truncate text-xs text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {showSettings && (
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings aria-hidden />
                Settings
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sun aria-hidden className="dark:hidden" />
              <Moon aria-hidden className="hidden dark:block" />
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                <DropdownMenuRadioItem value="light">
                  <Sun aria-hidden /> Light
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  <Moon aria-hidden /> Dark
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  <Monitor aria-hidden /> System
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <form action={signOut}>
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full">
              <LogOut aria-hidden />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
