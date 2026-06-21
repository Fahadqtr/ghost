-- ============================================================================
-- STEP 13 — set image_url for 60 Snoonu-sourced products (clears image BLOCKs).
-- Images are served from Snoonu CDN (https). Run on production yourself.
-- ============================================================================

update products p
set image_url = v.url, updated_at = now()
from (values
  ('mk1995', 'https://images.snoonu.com/product/2026-6/3f3d6aae-7f2b-44eb-9a98-2a71a65b5965_WhatsAppImage20260609at131026.jpeg'),
  ('mk1996', 'https://images.snoonu.com/product/2026-4/d8b0b62d-21bb-4434-bfec-5a0b333bb01a_WhatsAppImage20260423at185352.jpeg'),
  ('mk1997', 'https://images.snoonu.com/product/2026-6/074d2bac-7159-4c16-9f2e-ab6866eec3dd_WhatsAppImage20260608at155309.jpeg'),
  ('mk1998', 'https://images.snoonu.com/product/2026-6/007b4b1c-d5ef-4c4c-af82-1e95d8f4c28c_WhatsAppImage20260608at154107.jpeg'),
  ('mk2002', 'https://images.snoonu.com/product/2026-6/37a32373-d91e-4b36-80e9-2e9db1c0bfd4_WhatsAppImage20260603at213334.jpeg'),
  ('mk2003', 'https://images.snoonu.com/product/2026-6/f25f29d2-a3c8-49c3-924b-e7d5446e22c8_WhatsAppImage20260602at134558.jpeg'),
  ('mk2004', 'https://images.snoonu.com/product/2026-5/44a81189-dd19-484d-b394-1bf6139d2e05_WhatsAppImage20260531at144704.jpeg'),
  ('mk2005', 'https://images.snoonu.com/product/2026-5/6c5f134c-f8df-4140-af31-e64bdbadb29a_WhatsAppImage20260531at144647.jpeg'),
  ('mk2006', 'https://images.snoonu.com/product/2026-5/0831b6df-e3fc-4dd9-af3c-de5e9045047c_WhatsAppImage20260531at144628.jpeg'),
  ('mk2007', 'https://images.snoonu.com/product/2026-5/0831b6df-e3fc-4dd9-af3c-de5e9045047c_WhatsAppImage20260531at144628.jpeg'),
  ('mk2008', 'https://images.snoonu.com/product/2026-4/8ca0df1b-5c38-43a7-82cc-cce419caf13e_WhatsAppImage20260417at151751.jpeg'),
  ('mk2009', 'https://images.snoonu.com/product/2026-5/5dd47307-6f01-44ff-8dde-4b67cde65821_WhatsAppImage20260531at144606.jpeg'),
  ('mk2010', 'https://images.snoonu.com/product/2026-5/74b5107d-8987-46a5-b4f7-31049f1bf546_WhatsAppImage20260528at1334591.jpeg'),
  ('mk2011', 'https://images.snoonu.com/product/2026-4/d200b1f9-c2b9-49bc-8a6e-ca76efc0f705_WhatsAppImage20260407at214058.jpeg'),
  ('mk2012', 'https://images.snoonu.com/product/2026-5/89667735-1208-463e-aac4-0913aecdd89d_WhatsAppImage20260528at1320541.jpeg'),
  ('mk2013', 'https://images.snoonu.com/product/2026-5/cd2c92c6-c864-4ba1-ba0d-fdea2f5a04cf_WhatsAppImage20260528at1320331.jpeg'),
  ('mk2014', 'https://images.snoonu.com/product/2026-5/659572f8-5670-4c70-ae22-c1bade0ef88d_WhatsAppImage20260528at1320261.jpeg'),
  ('mk2015', 'https://images.snoonu.com/product/2026-5/abd2b626-55f8-4c92-a972-cbc25bb99a0f_WhatsAppImage20260527at1756401.jpeg'),
  ('mk2016', 'https://images.snoonu.com/product/2026-5/94978470-a90e-487d-a12b-9547d255a0fb_WhatsAppImage20260527at1756211.jpeg'),
  ('mk2017', 'https://images.snoonu.com/product/2026-5/ec310ceb-b9c6-4fbc-a37f-76f1e4539a2d_WhatsAppImage20260527at1756151.jpeg'),
  ('mk2018', 'https://images.snoonu.com/product/2026-5/9179102f-304c-4c1f-a195-7257db11303e_WhatsAppImage20260527at133354.jpeg'),
  ('mk2019', 'https://images.snoonu.com/product/2026-5/fac739bf-224d-40f8-8f9c-8c400cff349b_WhatsAppImage20260527at134015.jpeg'),
  ('mk2020', 'https://images.snoonu.com/product/2026-5/79dbaab3-fed9-4a5c-92a5-a197b1ef59a1_WhatsAppImage20260527at133110.jpeg'),
  ('mk2021', 'https://images.snoonu.com/product/2026-5/92a6ee60-68b7-4be5-8dad-81aa9caa6245_WhatsAppImage20260527at131217.jpeg'),
  ('mk2022', 'https://images.snoonu.com/product/2026-5/c6500839-09af-4d5b-be5e-a20c4f188609_WhatsAppImage20260527at131211.jpeg'),
  ('mk2023', 'https://images.snoonu.com/product/2026-5/2ff973e7-afb6-4a46-be45-b47d5c551663_WhatsAppImage20260526at1639062.jpeg'),
  ('mk2024', 'https://images.snoonu.com/product/2026-5/5fc28cab-f23a-4dfd-8cd5-d7b35fd040ba_WhatsAppImage20260526at163755.jpeg'),
  ('mk2025', 'https://images.snoonu.com/product/2026-5/a92d294f-ca0a-4f93-999a-7a749b577e9d_WhatsAppImage20260526at163637.jpeg'),
  ('mk2026', 'https://images.snoonu.com/product/2026-6/56a95743-9458-49de-9423-ba5a77f4501b_WhatsAppImage20260611at030414.jpeg'),
  ('mk2027', 'https://images.snoonu.com/product/2026-5/c23aa1f4-ba88-4a6b-933b-05d2020d85cc_WhatsAppImage20260525at1838472.jpeg'),
  ('mk2028', 'https://images.snoonu.com/product/2026-5/df5bf31f-5b47-4b07-b224-09f9f598244b_WhatsAppImage20260525at1837491.jpeg'),
  ('mk2029', 'https://images.snoonu.com/product/2026-5/1b1ba3d4-48a8-4d62-8a11-3b05fa3a2e9f_WhatsAppImage20260525at1835201.jpeg'),
  ('mk2030', 'https://images.snoonu.com/product/2026-5/096a3925-5729-4fc2-babe-156047ee40a8_WhatsAppImage20260525at183512.jpeg'),
  ('mk2031', 'https://images.snoonu.com/product/2026-5/17a25aa2-a94a-4c3d-9fe9-9d1989827f9d_WhatsAppImage20260525at1539591.jpeg'),
  ('mk2032', 'https://images.snoonu.com/product/2026-5/25e0a628-71ac-4507-9550-8c8728a2a1ed_WhatsAppImage20260525at1539521.jpeg'),
  ('mk2033', 'https://images.snoonu.com/product/2026-5/c7394872-4494-4983-8775-252422225350_WhatsAppImage20260525at1530241.jpeg'),
  ('mk2034', 'https://images.snoonu.com/product/2026-5/245e300b-800f-4ec1-8015-39408c14e5b0_WhatsAppImage20260525at1530161.jpeg'),
  ('mk2035', 'https://images.snoonu.com/product/2026-5/6ab2913d-cba7-43db-8b24-b0350495f252_WhatsAppImage20260525at1528561.jpeg'),
  ('mk2036', 'https://images.snoonu.com/product/2026-5/46089291-7ae2-4bf0-8126-20b3af860752_%D8%A3%D9%84%D9%82%D9%90%D9%86%D8%B8%D8%B1%D8%A9%D8%B9%D9%84%D9%89%D8%AA%D8%B5%D9%85%D9%8A%D9%85%D9%8A%D9%85%D9%86Canva.png'),
  ('mk2037', 'https://images.snoonu.com/product/2026-5/bd7013d7-6b46-456e-af74-c7b5f61d3fd7_WhatsAppImage20260525at1527231.jpeg'),
  ('mk2038', 'https://images.snoonu.com/product/2026-5/1c03a45b-8571-4875-b565-07480f06d8f5_WhatsAppImage20260524at2343151.jpeg'),
  ('mk2039', 'https://images.snoonu.com/product/2026-5/3f6df288-1f0e-4d9a-89ae-df106c2b1c79_WhatsAppImage20260524at2343092.jpeg'),
  ('mk2040', 'https://images.snoonu.com/product/2026-5/5815d3c2-45aa-4cfb-9634-bf7ce6d92632_%D8%A3%D9%84%D9%82%D9%90%D9%86%D8%B8%D8%B1%D8%A9%D8%B9%D9%84%D9%89%D8%AA%D8%B5%D9%85%D9%8A%D9%85%D9%8A%D9%85%D9%86Canva1.png'),
  ('mk2041', 'https://images.snoonu.com/product/2026-5/36154924-a75f-49a1-a0ae-3f05bb249162_WhatsAppImage20260524at185329.jpeg'),
  ('mk2042', 'https://images.snoonu.com/product/2026-5/0828fa0d-fbd8-4ce6-baab-49e7453fb092_WhatsAppImage20260524at0201421.jpeg'),
  ('mk2043', 'https://images.snoonu.com/product/2026-5/f0bd3737-b9cb-496e-a4c9-849781e18763_WhatsAppImage20260524at0201261.jpeg'),
  ('mk2044', 'https://images.snoonu.com/product/2026-6/87ea0a07-758b-43a5-b47b-e1158c44a70e_WhatsAppImage20260611at030114.jpeg'),
  ('mk2045', 'https://images.snoonu.com/product/2026-3/999782f7-514f-4050-acd7-fcb4b3f2a23b_WhatsAppImage20260315at204311.jpeg'),
  ('mk2046', 'https://images.snoonu.com/product/2026-5/f2c913c3-3d4a-43c3-8c14-d6b6437be8cc_WhatsAppImage20260523at170852.jpeg'),
  ('mk2047', 'https://images.snoonu.com/product/2026-5/1e9befdc-1b9d-4ec4-85d9-df6edfefa209_WhatsAppImage20260523at170829.jpeg'),
  ('mk2048', 'https://images.snoonu.com/product/2026-5/039b2c0c-6496-440e-8c1b-33adfbc81e33_WhatsAppImage20260523at170802.jpeg'),
  ('mk2049', 'https://images.snoonu.com/product/2026-5/4452ba6d-a31c-4cdc-b136-f10cdf2f432e_WhatsAppImage20260523at170713.jpeg'),
  ('mk2050', 'https://images.snoonu.com/product/2026-5/837caaff-0e6c-4a8e-a0f3-f3cf2652d276_WhatsAppImage20260523at170657.jpeg'),
  ('mk2051', 'https://images.snoonu.com/product/2026-5/51f543c7-49b4-4356-bb6a-6c86c5d6e994_WhatsAppImage20260523at170646.jpeg'),
  ('mk2052', 'https://images.snoonu.com/product/2026-5/938bce6d-66a6-4f44-8266-7b80f0baeb92_WhatsAppImage20260521at183459.jpeg'),
  ('mk2053', 'https://images.snoonu.com/product/2026-5/30b944a7-83d3-4365-a4e6-99f885011da5_WhatsAppImage20260521at155310.jpeg'),
  ('mk2054', 'https://images.snoonu.com/product/2026-5/1733f411-e3ba-4eb4-9bd6-59eaa1abd03e_WhatsAppImage20260521at155242.jpeg'),
  ('mk2055', 'https://images.snoonu.com/product/2026-5/1e782009-f117-4308-a7e2-2035ec8d30a6_WhatsAppImage20260521at155230.jpeg'),
  ('mk2056', 'https://images.snoonu.com/product/2026-5/01de809d-0bd4-400f-bbc5-bd8d7d22a249_WhatsAppImage20260521at155112.jpeg'),
  ('mk2057', 'https://images.snoonu.com/product/2026-5/3f5ddefa-e6d9-4757-86fa-5f464d9d1b5b_WhatsAppImage20260521at154903.jpeg')
) as v(sku, url)
where p.sku = v.sku;

-- verify: should return 0
select count(*) as still_missing_image
from products
where sku in ('mk1995','mk1996','mk1997','mk1998','mk2002','mk2003','mk2004','mk2005','mk2006','mk2007','mk2008','mk2009','mk2010','mk2011','mk2012','mk2013','mk2014','mk2015','mk2016','mk2017','mk2018','mk2019','mk2020','mk2021','mk2022','mk2023','mk2024','mk2025','mk2026','mk2027','mk2028','mk2029','mk2030','mk2031','mk2032','mk2033','mk2034','mk2035','mk2036','mk2037','mk2038','mk2039','mk2040','mk2041','mk2042','mk2043','mk2044','mk2045','mk2046','mk2047','mk2048','mk2049','mk2050','mk2051','mk2052','mk2053','mk2054','mk2055','mk2056','mk2057')
  and (image_url is null or image_url = '');
