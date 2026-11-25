"use client"

// app/admin/orders/OrdersManager.tsx
//
// One Orders page for the four sidebar entries (same idea as ShishaManager):
// the data lives here, so moving between Orders, Products and Categories &
// vendors keeps everything loaded with no refetch. The sidebar entry decides
// which section shows; AdminView passes it in as `section`.

import { useState, type Dispatch, type SetStateAction } from "react"

import { CatalogueSetup } from "./CatalogueSetup"
import { OrdersBoard } from "./OrdersBoard"
import { ProductsPanel } from "./ProductsPanel"
import type { AdminOrderSettings, AdminOrderVendor, OrdersData, OrdersPermissions, OrdersSection } from "./types"

export function OrdersManager({
  section,
  initialData,
  settings,
  vendors,
  onVendorsChange,
  permissions,
  timezone,
  currency,
}: {
  section: OrdersSection
  initialData: OrdersData
  /** Order settings and vendors live in AdminView: Settings > Order settings edits the same copies,
   *  so Products (default vendor) and Categories & vendors never show a stale value. */
  settings: AdminOrderSettings
  vendors: AdminOrderVendor[]
  onVendorsChange: Dispatch<SetStateAction<AdminOrderVendor[]>>
  permissions: OrdersPermissions
  timezone: string
  currency: string
}) {
  const [orders, setOrders] = useState(initialData.orders)
  const [products, setProducts] = useState(initialData.products)
  const [categories, setCategories] = useState(initialData.categories)

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
          timezone={timezone}
        />
      )}
      {section === "catalogue" && (
        <CatalogueSetup categories={categories} onCategoriesChange={setCategories} vendors={vendors} onVendorsChange={onVendorsChange} products={products} canManage={canManage} />
      )}
    </>
  )
}
