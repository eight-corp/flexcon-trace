export type Destination = {
  id: string
  name: string
  address: string | null
  contact_name: string | null
  active: boolean
  created_at: string
}

export type Worker = {
  worker_id: string
  worker_name: string
  role: 'admin' | 'operator' | 'viewer'
  display_order: number
  active: boolean
  note: string
}

export type TransportProfile = {
  id: string
  company_name: string
  driver_name: string | null
  vehicle_no: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export type Shipment = {
  id: string
  destination_id: string
  transport_profile_id: string | null
  shipped_at: string
  carrier_name: string | null
  driver_name: string | null
  vehicle_no: string | null
  note: string | null
  flexcon_destinations: { name: string } | null
  flexcon_shipment_items: { lot_number: string }[]
  workers: { worker_name: string } | null
}

export type AuthorizationRecord = {
  id: string
  authorization_no: string
  full_name: string
  seed_purchase_slip: boolean
  farming_plan: boolean
  address: string | null
  prefecture: string | null
  municipality: string | null
  phone: string | null
  crop_type: string | null
  feed_rice_variety: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export type InspectionRecord = {
  id: string
  record_no: number
  fiscal_year: number
  purchase_date: string | null
  inspection_date: string | null
  full_name: string
  prefecture: string | null
  municipality: string | null
  inspection_location: string | null
  authorization_no: string | null
  brand: string | null
  recommended_flexcon: number | null
  paper_bags: number | null
  bulk_quantity: number | null
  total_quantity: number | null
  grade: string | null
  moisture: number | null
  reason: string | null
  moisture_values: (number | null)[]
  created_by_worker_id: string
  updated_by_worker_id: string
  created_at: string
  updated_at: string
}

export type ProducerInspectionBatch = {
  id: string
  authorization_id: string
  purchase_date: string
  fiscal_year: number
  inspection_date: string | null
  inspection_location: string | null
  brand: string | null
  created_by_worker_id: string
  updated_by_worker_id: string
  created_at: string
  updated_at: string
}

export type FlexconInspection = {
  id: string
  batch_id: string
  flexcon_no: number
  lot_number: string
  brand: string | null
  quantity_kg: number
  grade: string | null
  reason: string | null
  moisture: number | null
  moisture_values: (number | null)[]
  created_by_worker_id: string
  updated_by_worker_id: string
  created_at: string
  updated_at: string
}

export type PaperBagInspection = {
  id: string
  batch_id: string
  brand: string | null
  bag_count: number
  grade: string | null
  reason: string | null
  moisture: number | null
  moisture_values: (number | null)[]
  created_by_worker_id: string
  updated_by_worker_id: string
  created_at: string
  updated_at: string
}

export type InspectionWeight = {
  weight_type: 'branded_rice' | 'feed_rice'
  weight_kg: number
  updated_at: string
}

export type InspectionOption = {
  id: string
  option_type: 'location' | 'brand' | 'brand_aomori' | 'brand_iwate' | 'grade' | 'grade_reason'
  name: string
  active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}
