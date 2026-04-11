import { db } from "../../src/database/db";
import { generateSku } from "../../src/helpers/inventory-helpers";

async function main() {
  console.log("Starting SKU backfill...");

  const items = await db.inventoryItem.findMany({
    where: {
      sku: null,
    },
  });

  console.log(`Found ${items.length} items without SKU.`);

  let updatedCount = 0;
  for (const item of items) {
    const newSku = generateSku(item.itemName);
    await db.inventoryItem.update({
      where: { id: item.id },
      data: { sku: newSku },
    });
    updatedCount++;
    if (updatedCount % 10 === 0) {
      console.log(`Updated ${updatedCount}/${items.length} items...`);
    }
  }

  console.log(`Backfill complete. Updated ${updatedCount} items.`);
}

main()
  .catch((e) => {
    console.error("Error during backfill:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
