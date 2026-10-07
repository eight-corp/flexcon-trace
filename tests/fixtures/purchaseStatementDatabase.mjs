import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

export async function purchaseStatementDatabase() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table workers(worker_id text primary key, worker_name text, active boolean default true, role text default 'operator');
    insert into workers(worker_id,worker_name,role) values ('reader','Reader','operator'),('reviewer','Reviewer','operator'),('admin','Admin','admin'),('viewer','Viewer','viewer');
    create function flexcon_require_active_worker(p_worker_id text) returns workers language plpgsql as $$
    declare v_worker workers; begin
      select * into v_worker from workers where worker_id=p_worker_id and active;
      if not found or p_worker_id<>current_setting('fixture.actor',true) then raise exception 'unauthorized'; end if;
      return v_worker;
    end $$;
    create function flexcon_require_admin_worker(p_worker_id text) returns workers language plpgsql as $$
    declare v_worker workers; begin v_worker:=flexcon_require_active_worker(p_worker_id);
      if v_worker.role<>'admin' then raise exception 'unauthorized'; end if; return v_worker; end $$;
    create function flexcon_set_purchase_statement_scope(p_worker_id text,p_min_role text) returns void language plpgsql as $$
    declare v_worker workers; begin v_worker:=flexcon_require_active_worker(p_worker_id);
      if (p_min_role='admin' and v_worker.role<>'admin') or (p_min_role='operator' and v_worker.role='viewer') then raise exception 'unauthorized'; end if;
    end $$;`)
  for (const name of [
    '202609180002_purchase_statement_documents.sql', '202609180003_purchase_statement_payment_method.sql',
    '202609180005_purchase_statement_images.sql', '202609180006_purchase_statement_tax_exempt_amount.sql',
    '202609180007_purchase_statement_tax_exempt_negative_amount.sql', '202609180008_purchase_statement_tax_treatment.sql',
    '202609180009_purchase_statement_item_origins.sql', '202609190001_purchase_statement_duplicate_and_product_master.sql',
  ]) await db.exec(fs.readFileSync(`supabase/migrations/${name}`, 'utf8'))
  await db.exec(`alter function flexcon_save_purchase_statement(text,uuid,text,jsonb,jsonb) rename to flexcon_save_purchase_statement_internal;`)
  const rpc = (actor, name, args) => db.transaction(async tx => {
    await tx.query("select set_config('fixture.actor',$1,true)", [actor])
    const entries = Object.entries(args)
    const bindings = entries.map(([key], index) => `${key} => $${index + 1}`).join(',')
    const result = await tx.query(`select ${name}(${bindings}) as result`, entries.map(([, value]) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))
    return result.rows[0].result
  })
  const legacyId = await rpc('admin', 'flexcon_save_purchase_statement_internal', {
    p_worker_id: 'admin', p_statement_id: null, p_source_type: 'manual', p_header: validHeader('LEGACY'), p_items: validItems(),
  })
  await db.exec(fs.readFileSync('supabase/migrations/202610070002_purchase_statement_review.sql', 'utf8'))
  return { db, rpc, legacyId }
}

export const validHeader = (number = '100') => ({
  statement_date: '2026-10-07', document_number: number, recipient: '担当者', issuer: '仕入先',
  payment_method: 'cash', tax_treatment: 'exclusive', tax_rate: 10, tax_amount: 100, total_amount: 1100, invoice_number: 'T1234567890123',
})
export const validItems = () => [{ crop_year: '2026', origin: '青森', product_name: '青天のへきれき', package_type: 'フレコン', quantity: 1, unit: '本', unit_price: 1000, amount: 1000 }]
