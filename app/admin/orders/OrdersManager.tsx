"use client"

// app/admin/orders/OrdersManager.tsx
//
// One Orders page for the four sidebar entries (same idea as ShishaManager):
// the data lives here, so moving between Orders, Products and Categories &
// vendors keeps everything loaded with no refetch. The sidebar entry decides
// which section shows; AdminView passes it in as `section`.

import { useState } from "react"

import { CatalogueSetup } from "./CatalogueSetup"
import { OrderSettingsPanel } from "./OrderSettingsPanel"
import { OrdersBoard } from "./OrdersBoard"
import { ProductsPanel } from "./ProductsPanel"
import type { OrdersData, OrdersPermissions, OrdersSection } from "./types"

export function OrdersManager({
  section,
  initialData,
  permissions,
  timezone,
  currency,
}: {
  section: OrdersSection
  initialData: OrdersData
  permissions: OrdersPermissions
  timezone: string
  currency: string
}) {
  const [orders, setOrders] = useState(initialData.orders)
  const [products, setProducts] = useState(initialData.products)
  const [categories, setCategories] = useState(initialData.categories)
  const [vendors, setVendors] = useState(initialData.vendors)
  const [settings, setSettings] = useState(initialData.settings)

  const canManage = permissions.manage
  const canOperate = permissions.operate || permissions.manage

  return (
    <>
      {section === "board" && (
        <OrdersBoard orders={orders} onOrdersChange={setOrders} vendors={vendors} canOperate={canOperate} timezone={timezone} currency={currency} />
      )}
      {section === "products" && (
        <ProductsPanel
          products={products}
          onProductsChange={setProducts}
          categories={categories}
          vendors={vendors}
          defaultVendorId={settings.defaultVendorId}
          canManage={canManage}
          currency={currency}
        />
      )}
      {section === "catalogue" && (
        <CatalogueSetup categories={categories} onCategoriesChange={setCategories} vendors={vendors} onVendorsChange={setVendors} products={products} canManage={canManage} />
      )}
      {section === "settings" && (
        // key: remount with fresh form state if the settings object is replaced after a save
        <OrderSettingsPanel key={settings.configured ? "saved" : "new"} settings={settings} onSaved={setSettings} vendors={vendors} canManage={canManage} />
      )}
    </>
  )
}
