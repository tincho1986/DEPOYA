-- ============================================================  
-- CargaYa Demo — esquema + seed  
-- Pegar COMPLETO en Neon (neon.tech) → SQL Editor → Run  
-- ============================================================  
  
CREATE TABLE brands (id UUID PRIMARY KEY, name TEXT, slug TEXT UNIQUE);  
  
CREATE TABLE users (id UUID PRIMARY KEY, email TEXT, full_name TEXT, role TEXT, phone TEXT);  
  
CREATE TABLE user_addresses (id UUID PRIMARY KEY, user_id UUID, label TEXT, street TEXT, city TEXT,  
  lat DOUBLE PRECISION, lng DOUBLE PRECISION, notes TEXT, is_default BOOLEAN DEFAULT false);  
  
CREATE TABLE vehicle_types (id SERIAL PRIMARY KEY, code TEXT UNIQUE, name TEXT,  
  max_weight_kg NUMERIC, max_volume_m3 NUMERIC, max_length_cm NUMERIC, vol_factor_kgm3 NUMERIC,  
  base_fee NUMERIC, per_km NUMERIC, per_kg NUMERIC, per_m3 NUMERIC, per_helper NUMERIC, min_fee NUMERIC,  
  avg_speed_kmh NUMERIC, driver_share_pct NUMERIC);  
  
CREATE TABLE drivers (user_id UUID PRIMARY KEY, status TEXT DEFAULT 'pending', is_online BOOLEAN DEFAULT false,  
  lat DOUBLE PRECISION, lng DOUBLE PRECISION, rating_avg NUMERIC DEFAULT 5,  
  hazmat_certified BOOLEAN DEFAULT false, bank_cbu TEXT, last_seen_at TIMESTAMPTZ DEFAULT now());  
  
CREATE TABLE vehicles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), driver_id UUID, vehicle_type_id INT,  
  plate TEXT, brand TEXT, model TEXT, capacity_kg NUMERIC, capacity_m3 NUMERIC, is_verified BOOLEAN DEFAULT false);  
  
CREATE TABLE merchants (id UUID PRIMARY KEY, owner_id UUID, name TEXT, vertical TEXT,  
  lat DOUBLE PRECISION, lng DOUBLE PRECISION, address_text TEXT,  
  status TEXT DEFAULT 'active', is_open BOOLEAN DEFAULT true, auto_accept_orders BOOLEAN DEFAULT false);  
  
CREATE TABLE categories (id UUID PRIMARY KEY, vertical TEXT, name TEXT, slug TEXT);  
  
CREATE TABLE products (id UUID PRIMARY KEY, merchant_id UUID, category_id UUID, brand_id UUID,  
  sku TEXT, name TEXT, unit TEXT DEFAULT 'unit', base_price NUMERIC, weight_kg NUMERIC DEFAULT 0,  
  length_cm NUMERIC, width_cm NUMERIC, height_cm NUMERIC, max_length_cm NUMERIC, requires_vehicle TEXT,  
  is_fragile BOOLEAN DEFAULT false, is_hazardous BOOLEAN DEFAULT false, helpers_required INT DEFAULT 0,  
  stock NUMERIC DEFAULT 0, low_stock_threshold NUMERIC DEFAULT 5, status TEXT DEFAULT 'active');  
  
CREATE TABLE vehicle_makes (id UUID PRIMARY KEY, name TEXT, slug TEXT UNIQUE);  
CREATE TABLE vehicle_models (id UUID PRIMARY KEY, make_id UUID, name TEXT, slug TEXT);  
  
CREATE TABLE product_compatibility (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID,  
  make_id UUID, model_id UUID, year_from INT, year_to INT, position_note TEXT);  
  
CREATE TABLE product_oem_codes (product_id UUID, code TEXT);  
  
CREATE TABLE quotes (id UUID PRIMARY KEY, data JSONB, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());  
  
CREATE TABLE orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT UNIQUE,  
  client_id UUID, merchant_id UUID, quote_id UUID, status TEXT DEFAULT 'placed',  
  subtotal NUMERIC, shipping_total NUMERIC, discount_total NUMERIC DEFAULT 0, grand_total NUMERIC,  
  currency TEXT DEFAULT 'ARS',  
  dropoff_address JSONB, dropoff_lat DOUBLE PRECISION, dropoff_lng DOUBLE PRECISION,  
  payment_method TEXT DEFAULT 'cash', payment_status TEXT DEFAULT 'pending', notes TEXT,  
  placed_at TIMESTAMPTZ DEFAULT now(), accepted_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ,  
  cancellation_reason TEXT);  
  
CREATE TABLE order_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID, product_id UUID,  
  name_snapshot TEXT, sku_snapshot TEXT, unit TEXT, quantity NUMERIC, unit_price NUMERIC,  
  subtotal NUMERIC, weight_kg_each NUMERIC);  
  
CREATE TABLE payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID, amount NUMERIC,  
  method TEXT, provider TEXT, provider_ref TEXT, status TEXT DEFAULT 'pending');  
  
CREATE TABLE shipments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID, trip_number INT DEFAULT 1,  
  driver_id UUID, vehicle_type_id INT, vehicle_code TEXT, status TEXT DEFAULT 'unassigned', rounds INT DEFAULT 0,  
  pickup_lat DOUBLE PRECISION, pickup_lng DOUBLE PRECISION,  
  dropoff_lat DOUBLE PRECISION, dropoff_lng DOUBLE PRECISION,  
  distance_km NUMERIC, weight_kg NUMERIC, volume_m3 NUMERIC, helpers_count INT DEFAULT 0,  
  driver_payout NUMERIC, cod_amount NUMERIC DEFAULT 0,  
  assigned_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());  
  
CREATE TABLE shipment_offers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), shipment_id UUID, driver_id UUID,  
  status TEXT DEFAULT 'pending', payout NUMERIC, offered_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ);  
  
CREATE TABLE shipment_proofs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), shipment_id UUID, stage TEXT,  
  image_url TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, geo_verified BOOLEAN,  
  captured_at TIMESTAMPTZ DEFAULT now());  
  
CREATE TABLE ledger_entries (id BIGSERIAL PRIMARY KEY, account_type TEXT, account_id TEXT,  
  entry_type TEXT, amount NUMERIC, order_id UUID, description TEXT, created_at TIMESTAMPTZ DEFAULT now());  
  
CREATE TABLE stock_movements (id BIGSERIAL PRIMARY KEY, product_id UUID, delta NUMERIC, reason TEXT,  
  order_id UUID, created_at TIMESTAMPTZ DEFAULT now());  
  
CREATE TABLE admin_audit_log (id BIGSERIAL PRIMARY KEY, actor TEXT, action TEXT, detail JSONB,  
  created_at TIMESTAMPTZ DEFAULT now());  
  
-- ═══════════════ SEED (IDs fijos) ═══════════════  
  
INSERT INTO users (id, email, full_name, role, phone) VALUES  
('11111111-1111-4111-8111-111111111111','cliente@test.com','Ana Cliente','client','+5491100000001'),  
('22222222-2222-4222-8222-222222222222','driver@test.com','Bruno Flete','driver','+5491100000002'),  
('33333333-3333-4333-8333-333333333333','comercio@test.com','Carla Corralón','merchant_admin','+5491100000003'),  
('44444444-4444-4444-8444-444444444444','admin@test.com','Super Admin','superadmin','+5491100000004');  
  
INSERT INTO user_addresses (id, user_id, label, street, city, lat, lng, is_default) VALUES  
('12121212-1212-4121-8121-121212121212','11111111-1111-4111-8111-111111111111',  
 'Obra','Av. 9 de Julio 1000','CABA',-34.6037,-58.3816,true);  
  
INSERT INTO vehicle_types  
 (code,name,max_weight_kg,max_volume_m3,max_length_cm,vol_factor_kgm3,  
  base_fee,per_km,per_kg,per_m3,per_helper,min_fee,avg_speed_kmh,driver_share_pct) VALUES  
('motorcycle','Moto',40,0.15,120,300,700,90,18,0,0,900,28,80),  
('car','Auto',120,0.6,160,280,900,100,15,200,0,1200,30,75),  
('pickup','Camioneta',800,2.5,250,250,1500,110,8,220,3500,1800,32,72),  
('van','Flete chico',1500,8,320,250,2200,120,6,250,4000,2800,35,70),  
('flatbed','Flete pesado',6000,22,600,180,4500,160,4,300,6000,6000,40,70);  
  
-- Repartidor aprobado, ONLINE, en CABA (lat=-34.59, lng=-58.42)  
INSERT INTO drivers (user_id,status,is_online,lat,lng,hazmat_certified,bank_cbu) VALUES  
('22222222-2222-4222-8222-222222222222','approved',true,-34.59,-58.42,true,'0000003100012345678901');  
  
INSERT INTO vehicles (driver_id,vehicle_type_id,plate,brand,model,capacity_kg,capacity_m3,is_verified)  
SELECT '22222222-2222-4222-8222-222222222222', id, 'AB123CD','Mercedes','Sprinter',1500,8,true  
FROM vehicle_types WHERE code='van';  
  
INSERT INTO merchants (id,owner_id,name,vertical,lat,lng,address_text) VALUES  
('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333',  
 'Corralón La Obra','construction',-34.5780,-58.4450,'Av. Santa Fe 3000'),  
('55555556-5555-4555-8555-555555555556','33333333-3333-4333-8333-333333333333',  
 'Repuestos Belgrano','auto_parts',-34.6000,-58.4400,'Av. Belgrano 1200');  
  
INSERT INTO categories (id,vertical,name,slug) VALUES  
('66666666-6666-4666-8666-666666666667','construction','Cemento y cal','cemento'),  
('66666666-6666-4666-8666-666666666669','auto_parts','Frenos','frenos');  
  
INSERT INTO brands (id,name,slug) VALUES ('88888888-8888-4888-8888-888888888888','Bosch','bosch');  
  
INSERT INTO products (id,merchant_id,category_id,sku,name,unit,base_price,weight_kg,  
                      length_cm,width_cm,height_cm,stock) VALUES  
('77777771-7777-4777-8777-777777777771','55555555-5555-4555-8555-555555555555',  
 '66666666-6666-4666-8666-666666666667','CEM-PORT-50','Cemento portland 50 kg','unit',9500,50,55,35,12,100),  
('77777772-7777-4777-8777-777777777772','55555555-5555-4555-8555-555555555555',  
 '66666666-6666-4666-8666-666666666667','CAL-25','Cal común 25 kg','unit',4200,25,50,30,10,50);  
  
INSERT INTO products (id,merchant_id,category_id,brand_id,sku,name,unit,base_price,weight_kg,stock) VALUES  
('77777773-7777-4777-8777-777777777773','55555556-5555-4555-8555-555555555556',  
 '66666666-6666-4666-8666-666666666669','88888888-8888-4888-8888-888888888888',  
 'FRE-DB-1134','Pastillas de freno delanteras Kangoo 1.6','set',48500,1.8,10);  
  
INSERT INTO vehicle_makes (id,name,slug) VALUES  
('99999999-9999-4999-8999-999999999991','Renault','renault');  
INSERT INTO vehicle_models (id,make_id,name,slug) VALUES  
('99999999-9999-4999-8999-999999999992','99999999-9999-4999-8999-999999999991','Kangoo','kangoo');  
  
INSERT INTO product_compatibility (product_id,make_id,model_id,year_from,year_to,position_note)  
VALUES ('77777773-7777-4777-8777-777777777773','99999999-9999-4999-8999-999999999991',  
        '99999999-9999-4999-8999-999999999992',2008,2018,'delantero');  
  
INSERT INTO product_oem_codes (product_id,code)  
VALUES ('77777773-7777-4777-8777-777777777773','7701207213');  
