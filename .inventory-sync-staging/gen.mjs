import fs from "fs";
const LOC="gid://shopify/Location/81908531438";
const {set50}=JSON.parse(fs.readFileSync("/tmp/towrite.json","utf8"));
const ids=set50;
const P="gid://shopify/InventoryItem/";
function chunk(a,n){const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;}
// tracking chunks of 100
const tc=chunk(ids,100);
tc.forEach((c,i)=>{
  let m="mutation {\n";
  c.forEach((id,j)=>{m+=`  t${j}: inventoryItemUpdate(id: "${P}${id}", input: {tracked: true}) { inventoryItem { id } userErrors { field message } }\n`;});
  m+="}";
  fs.writeFileSync(`/tmp/track_${i}.graphql`,m);
});
// set chunks of 250
const sc=chunk(ids,250);
sc.forEach((c,i)=>{
  const q=c.map(id=>`{inventoryItemId: "${P}${id}", locationId: "${LOC}", quantity: 50}`).join("\n      ");
  const m=`mutation {\n  inventorySetQuantities(input: {name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: [\n      ${q}\n  ]}) {\n    inventoryAdjustmentGroup { changes { delta } }\n    userErrors { field message }\n  }\n}`;
  fs.writeFileSync(`/tmp/set_${i}.graphql`,m);
});
console.log("ids:",ids.length,"| track files:",tc.length,"(100 each) | set files:",sc.length,"(250 each)");
console.log("track sizes:",tc.map(c=>c.length).join(","));
console.log("set sizes:",sc.map(c=>c.length).join(","));
