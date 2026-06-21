-- ============================================================================
-- STEP 14 (الخيار ب) — بعد رفع mkXXXX.jpg إلى bucket product-images من اللوحة،
-- اضبط image_url حسب اسم الملف (deterministic). 59 منتج (يستثني mk2026 لأن عنده صورة).
-- ============================================================================

update products
set image_url = 'https://vqstcmattiarhblqshvb.supabase.co/storage/v1/object/public/product-images/' || sku || '.jpg',
    updated_at = now()
where sku in ('mk1995','mk1996','mk1997','mk1998','mk2002','mk2003','mk2004','mk2005','mk2006','mk2007','mk2008','mk2009','mk2010','mk2011','mk2012','mk2013','mk2014','mk2015','mk2016','mk2017','mk2018','mk2019','mk2020','mk2021','mk2022','mk2023','mk2024','mk2025','mk2027','mk2028','mk2029','mk2030','mk2031','mk2032','mk2033','mk2034','mk2035','mk2036','mk2037','mk2038','mk2039','mk2040','mk2041','mk2042','mk2043','mk2044','mk2045','mk2046','mk2047','mk2048','mk2049','mk2050','mk2051','mk2052','mk2053','mk2054','mk2055','mk2056','mk2057');

-- verify: المفروض يرجع 59
select count(*) as set_ok
from products
where sku in ('mk1995','mk1996','mk1997','mk1998','mk2002','mk2003','mk2004','mk2005','mk2006','mk2007','mk2008','mk2009','mk2010','mk2011','mk2012','mk2013','mk2014','mk2015','mk2016','mk2017','mk2018','mk2019','mk2020','mk2021','mk2022','mk2023','mk2024','mk2025','mk2027','mk2028','mk2029','mk2030','mk2031','mk2032','mk2033','mk2034','mk2035','mk2036','mk2037','mk2038','mk2039','mk2040','mk2041','mk2042','mk2043','mk2044','mk2045','mk2046','mk2047','mk2048','mk2049','mk2050','mk2051','mk2052','mk2053','mk2054','mk2055','mk2056','mk2057')
  and image_url like 'https://vqstcmattiarhblqshvb.supabase.co/storage/v1/object/public/product-images/%';
