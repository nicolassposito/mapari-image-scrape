import puppeteer, { ElementHandle, Page } from "puppeteer";
import fs from "fs";
import path from "path";
import sharp from "sharp";

const printFolderPath = path.join(__dirname, "..", "print");

// Create the 'print' directory in the root folder if it doesn't exist
if (!fs.existsSync(printFolderPath)) {
  fs.mkdirSync(printFolderPath);
}

// Helper function to create a delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to compress image using Sharp
const compressImage = async (inputBuffer: Buffer): Promise<Buffer> => {
  return await sharp(inputBuffer)
    .trim() // Remove borders
    .jpeg({
      quality: 60, // Reduce quality to 60%
      mozjpeg: true, // Use mozjpeg compression
    })
    .withMetadata() // Preserve metadata
    .toBuffer();
};

// Helper function to hide elements except canvas
const hideElementsExceptCanvas = async (page: Page) => {
  await page.evaluate(() => {
    const elements = document.body.getElementsByTagName("*");
    Array.from(elements).forEach((element) => {
      const isCanvas = element.tagName === "CANVAS";
      const isCanvasParent = element.querySelector(
        "canvas.widget-scene-canvas"
      );
      const isImageClickable = element.classList.contains("OKAoZd");
      if (!isCanvas && !isCanvasParent && !isImageClickable) {
        (element as HTMLElement).style.visibility = "hidden";
      }
    });
  });
};

// Helper function to show all elements
const showAllElements = async (page: Page) => {
  await page.evaluate(() => {
    const elements = document.body.getElementsByTagName("*");
    Array.from(elements).forEach((element) => {
      (element as HTMLElement).style.visibility = "visible";
    });
  });
};

// Helper function to click element
const clickElement = async (page: Page, element: ElementHandle) => {
  await page.evaluate((el) => {
    // Create and dispatch mousedown event
    el.dispatchEvent(
      new MouseEvent("mousedown", {
        view: window,
        bubbles: true,
        cancelable: true,
        buttons: 1,
      })
    );

    // Create and dispatch click event
    el.dispatchEvent(
      new MouseEvent("click", {
        view: window,
        bubbles: true,
        cancelable: true,
        buttons: 1,
      })
    );

    // Create and dispatch mouseup event
    el.dispatchEvent(
      new MouseEvent("mouseup", {
        view: window,
        bubbles: true,
        cancelable: true,
        buttons: 1,
      })
    );
  }, element);
};

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  console.log("Navigating to page...");
  await page.goto("https://maps.google.com/?cid=9774150582194728568", {
    waitUntil: "networkidle0",
  });
  await delay(2000);

  console.log("Waiting for the button to appear...");
  await page.waitForSelector(".aoRNLd.kn2E5e.NMjTrf", {
    visible: true,
    timeout: 10000,
  });

  console.log("Attempting to click the button...");
  await page.click(".aoRNLd.kn2E5e.NMjTrf");
  await delay(2000);

  console.log("Waiting for the image links to appear...");
  await page.waitForSelector("a.OKAoZd", { visible: true, timeout: 10000 });
  await delay(2000);

  const imageLinks = await page.$$("a.OKAoZd");
  console.log(`Found ${imageLinks.length} image links.`);

  for (let i = 0; i < imageLinks.length; i++) {
    await showAllElements(page);
    await delay(2000);

    const currentLinks = await page.$$("a.OKAoZd");
    const link = currentLinks[i];

    try {
      await page.evaluate((element) => {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }, link);
      await delay(1000);

      console.log(`Clicking image link ${i + 1}...`);

      try {
        await clickElement(page, link);
        await delay(1000);

        if (!(await page.$("canvas.widget-scene-canvas"))) {
          await link.click({ delay: 100 });
          await delay(1000);
        }

        if (!(await page.$("canvas.widget-scene-canvas"))) {
          const box = await link.boundingBox();
          if (box) {
            await page.mouse.click(
              box.x + box.width / 2,
              box.y + box.height / 2
            );
          }
        }
      } catch (clickError) {
        console.log(
          `Click error for image ${i + 1}, trying alternative method:`,
          clickError
        );
        await page.evaluate((el) => (el as HTMLElement).click(), link);
      }

      await delay(2000);

      console.log("Waiting for canvases to appear...");
      await page.waitForSelector("canvas.widget-scene-canvas", {
        visible: true,
        timeout: 10000,
      });
      await delay(1000);

      await hideElementsExceptCanvas(page);
      await delay(1000);

      const canvases = await page.$$("canvas.widget-scene-canvas");
      if (canvases.length > 0) {
        const canvas = canvases[0];
        const screenshotBuffer = await canvas.screenshot();

        // Process and compress the image
        try {
          const compressedBuffer = await compressImage(
            Buffer.from(screenshotBuffer)
          );

          // Save only the compressed version
          const outputPath = path.join(
            printFolderPath,
            `compressed_image_${i + 1}.jpg`
          );
          await fs.promises.writeFile(outputPath, compressedBuffer);

          // Log compression results
          const originalSize = screenshotBuffer.length;
          const compressedSize = compressedBuffer.length;
          const compressionRatio = (
            ((originalSize - compressedSize) / originalSize) *
            100
          ).toFixed(2);

          console.log(
            `Image ${
              i + 1
            } compressed: ${compressionRatio}% reduction (${originalSize} -> ${compressedSize} bytes)`
          );
        } catch (compressionError) {
          console.log(`Error compressing image ${i + 1}:`, compressionError);
        }

        await showAllElements(page);
        await delay(2000);
      } else {
        console.log(`No canvas found after clicking image link ${i + 1}.`);
      }
    } catch (error) {
      console.log(`Error processing image link ${i + 1}:`, error);
      await showAllElements(page);
      await delay(2000);
      continue;
    }
  }

  console.log("Process complete. Browser will remain open.");
})();
