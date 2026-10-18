"use client"

// app/demo/SetupBranding.tsx
//
// A playable copy of Settings > Branding (BrandingPanels.tsx): display name, logo, brand
// colours, custom dashboard colours, and "Remove Powered by". Changes apply at once: the
// sidebar of this window, the customer ticket on the right, the clock pad and the payslip
// all pick them up. (The real panel has a Save button and some of these are Business-plan
// features; here they are all switched on so a visitor can try them.)

import { useRef, useState } from "react"
import admin from "./adminDemo.module.css"
import s from "./setupDemo.module.css"
import { ColorField, Field, PlanTag, Switch } from "./SetupBits"
import { useSetup } from "./SetupContext"
import { readableTextOn } from "./setupData"

const MAX_LOGO_BYTES = 2 * 1024 * 1024
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]

export function SetupBranding() {
  const { brand, setBrand, industry } = useSetup()
  const fileRef = useRef<HTMLInputElement>(null)
  const [logoError, setLogoError] = useState<string | null>(null)

  function pickLogo(file: File | null) {
    if (!file) return
    setLogoError(null)
    if (!ALLOWED.includes(file.type)) return setLogoError("Logo must be a PNG, JPEG, WebP, or SVG image")
    if (file.size > MAX_LOGO_BYTES) return setLogoError("Logo must be 2MB or smaller")
    const reader = new FileReader()
    reader.onload = () => setBrand({ logo: typeof reader.result === "string" ? reader.result : null })
    reader.onerror = () => setLogoError("Couldn’t read that file. Try another image.")
    reader.readAsDataURL(file)
    if (fileRef.current) fileRef.current.value = ""
  }

  function useBrandColours() {
    setBrand({ sidebarColor: brand.primary, sidebarText: readableTextOn(brand.primary), accent: brand.secondary })
  }

  function toggleCustomSidebar(next: boolean) {
    if (next) setBrand({ customSidebar: true, sidebarColor: brand.primary, sidebarText: readableTextOn(brand.primary), accent: brand.secondary })
    else setBrand({ customSidebar: false })
  }

  const headBg = brand.primary
  const headText = readableTextOn(headBg)
  const chipBg = brand.secondary
  const chipText = readableTextOn(chipBg)
  const first = (brand.name.trim() || industry.shop).charAt(0).toUpperCase()

  return (
    <div className={s.twoCol}>
      <div className={s.stack}>
        <div className={admin.aCard}>
          <span className={admin.aCardTitle}>Brand identity</span>
          <span className={admin.aCardSub}>The name, logo and colours customers see on the kiosk, tickets, WhatsApp and the clock-in pad.</span>

          <div className={s.fields}>
            <Field label="Display name">
              {(id) => <input id={id} className={admin.aInput} value={brand.name} maxLength={60} onChange={(e) => setBrand({ name: e.target.value })} />}
            </Field>

            <div className={admin.aField}>
              <span className={admin.aFieldLabel}>
                Logo <PlanTag />
              </span>
              <div className={s.logoRow}>
                <span className={s.logoBox}>
                  {brand.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a local data: URL from the visitor's own file
                    <img src={brand.logo} alt="Your logo" />
                  ) : (
                    <span className={s.logoEmpty}>No logo</span>
                  )}
                </span>
                <span className={s.logoBtns}>
                  <button type="button" className={admin.aBtn} onClick={() => fileRef.current?.click()}>
                    {brand.logo ? "Change logo" : "Upload logo"}
                  </button>
                  {brand.logo && (
                    <button type="button" className={`${admin.aBtn} ${admin.aBtnGhost}`} onClick={() => setBrand({ logo: null })}>
                      Remove
                    </button>
                  )}
                </span>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className={s.hiddenInput}
                  onChange={(e) => pickLogo(e.target.files?.[0] ?? null)}
                />
              </div>
              <span className={admin.aHint}>PNG, JPEG, WebP or SVG, up to 2MB. It stays in your browser: nothing is uploaded.</span>
              {logoError && <span className={`${admin.aNote} ${admin.aNoteWarn}`}>{logoError}</span>}
            </div>

            <div className={`${admin.aFields} ${admin.aPair}`}>
              <ColorField label="Primary colour" value={brand.primary} onChange={(hex) => setBrand({ primary: hex })} />
              <ColorField label="Secondary colour" value={brand.secondary} onChange={(hex) => setBrand({ secondary: hex })} />
            </div>
          </div>
        </div>

        <div className={admin.aCard}>
          <div className={admin.aToggle}>
            <span>
              <span className={admin.aCardTitle}>
                Custom dashboard colours <PlanTag />
              </span>
              <span className={admin.aCardSub}>Colour the sidebar of this dashboard. Off keeps the standard look.</span>
            </span>
            <Switch checked={brand.customSidebar} onChange={toggleCustomSidebar} label="Custom dashboard colours" />
          </div>
          {brand.customSidebar && (
            <>
              <div className={s.threeCols}>
                <ColorField label="Sidebar" value={brand.sidebarColor} onChange={(hex) => setBrand({ sidebarColor: hex })} />
                <ColorField label="Sidebar text" value={brand.sidebarText} onChange={(hex) => setBrand({ sidebarText: hex })} />
                <ColorField label="Active item" value={brand.accent} onChange={(hex) => setBrand({ accent: hex })} />
              </div>
              <div className={admin.aBtns}>
                <button type="button" className={`${admin.aBtn} ${admin.aBtnGhost}`} onClick={useBrandColours}>
                  Use my brand colours
                </button>
              </div>
            </>
          )}
        </div>

        <div className={admin.aCard}>
          <div className={admin.aToggle}>
            <span>
              <span className={admin.aCardTitle}>
                Remove “Powered by ZozoQueue” <PlanTag />
              </span>
              <span className={admin.aCardSub}>Hide the platform footer from everything your customers and staff see.</span>
            </span>
            <Switch checked={brand.removePoweredBy} onChange={(next) => setBrand({ removePoweredBy: next })} label="Remove Powered by ZozoQueue" />
          </div>
        </div>
      </div>

      <div className={s.previewWrap}>
        <span className={s.previewLabel}>What your customers see</span>
        <div className={s.ticket}>
          <div className={s.ticketHead} style={{ background: headBg, color: headText }}>
            <span className={s.ticketLogo} style={{ background: brand.logo ? "#ffffff" : chipBg, color: chipText }}>
              {brand.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local data: URL from the visitor's own file
                <img src={brand.logo} alt="" />
              ) : (
                first
              )}
            </span>
            <span className={s.ticketName}>{brand.name.trim() || industry.shop}</span>
          </div>
          <div className={s.ticketBody}>
            <span className={s.ticketEyebrow}>Your place in line</span>
            <span className={s.ticketNumber} style={{ color: headBg }}>
              {industry.ticket}
            </span>
            <span className={s.ticketChip} style={{ background: chipBg, color: chipText }}>
              About {industry.waitMin} min
            </span>
            <span className={s.ticketLine}>
              {industry.position - 1} {industry.position - 1 === 1 ? "person" : "people"} ahead of you
            </span>
          </div>
          {!brand.removePoweredBy && <span className={s.ticketFoot}>Powered by ZozoQueue</span>}
        </div>
        <span className={s.previewNote}>The same name, logo and colours appear on the kiosk, WhatsApp confirmations and the staff clock-in pad.</span>
      </div>
    </div>
  )
}
