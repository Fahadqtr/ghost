import fs from "fs";
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(s);const pv=j.data.productVariants;let n=0;
  for(const v of pv.nodes){if(!v.inventoryItem)continue;const id=v.inventoryItem.id.split("/").pop();
    fs.appendFileSync("/tmp/items.ndjson",(v.sku||"")+"\t"+id+"\t"+(v.inventoryItem.tracked?1:0)+"\n");n++;}
  console.log("appended:",n,"total now:",fs.readFileSync("/tmp/items.ndjson","utf8").split("\n").filter(Boolean).length,"| hasNext:",pv.pageInfo.hasNextPage,"| cursor:",pv.pageInfo.endCursor);
});
