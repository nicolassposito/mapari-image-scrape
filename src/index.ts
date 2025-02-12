import puppeteer, { ElementHandle, Page } from "puppeteer";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

// Load environment variables
dotenv.config();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_PROJECT_URL!,
  process.env.NEXT_SUPABASE_SERVICE_ROLE_KEY!
);

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  }
});

const BATCH_SIZE = 20;
const MAX_IMAGES = 5;
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME!;
const PROCESSING_TIMEOUT_MINUTES = 30; // Consider a place "stuck" if processing takes longer than this
const WORKER_ID = `${os.hostname()}-${uuidv4()}`; // Unique ID for this worker/computer

async function processImageLink(page: Page, link: ElementHandle): Promise<void> {
  await page.evaluate((element) => {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }, link);
  await delay(1000);

  console.log("Attempting to click image link...");

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
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
  } catch (clickError) {
    console.log("Click error, trying alternative method:", clickError);
    await page.evaluate((el) => (el as HTMLElement).click(), link);
  }

  await delay(2000);

  console.log("Checking canvas visibility...");
  await page.waitForSelector("canvas.widget-scene-canvas", {
    visible: true,
    timeout: 10000,
  });

  if (!(await isCanvasVisible(page))) {
    throw new Error("Canvas is not visible after clicking");
  }

  await hideElementsExceptCanvas(page);
  await delay(1000);
}

// Helper function to upload to S3
async function uploadToS3(fileBuffer: Buffer, fileName: string): Promise<string> {
  // Add places_photos prefix to the Key
  const key = `places_photos/${fileName}`;
  
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: 'image/jpeg'
  });

  await s3Client.send(command);
  return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

// Helper function to process a single place
async function processPlace(page: Page, mapariId: string, placeUrl: string): Promise<string[]> {
  const imageUrls: string[] = [];
  
  try {
    console.log(`Processing place ${mapariId}...`);
    await page.goto(placeUrl, { waitUntil: "networkidle0" });
    await delay(2000);

    console.log("Waiting for the button to appear...");
    const buttonSelector = ".aoRNLd.kn2E5e.NMjTrf";
    const buttonExists = await page.$(buttonSelector) !== null;
    
    if (!buttonExists) {
      console.log("No photo button found for this place");
      return imageUrls;
    }

    await page.click(buttonSelector);
    await delay(2000);

    // Check if image gallery exists
    const hasImageGallery = await page.evaluate(() => {
      return document.querySelectorAll("a.OKAoZd").length > 0;
    });

    if (!hasImageGallery) {
      // Handle street view case
      try {
        const screenshotBuffer = await captureStreetView(page);
        if (screenshotBuffer) {
          const fileName = `${mapariId}/street_view.jpg`;
          const s3Url = await uploadToS3(screenshotBuffer, fileName);
          imageUrls.push(s3Url);
        }
      } catch (error) {
        console.error(`Error capturing street view for ${mapariId}:`, error);
      }
    } else {
      // Handle image gallery case
      const galleryUrls = await processImageGallery(page, mapariId);
      imageUrls.push(...galleryUrls);
    }
  } catch (error) {
    console.error(`Error processing place ${mapariId}:`, error);
  }

  return imageUrls;
}

// Modified helper function to capture street view and return buffer
async function captureStreetView(page: Page): Promise<Buffer | null> {
  console.log("Attempting to capture street view...");
  await delay(2000);

  try {
    await page.waitForSelector("canvas.widget-scene-canvas", {
      visible: true,
      timeout: 10000,
    });

    if (!(await isCanvasVisible(page))) {
      throw new Error("Street view canvas is not visible");
    }

    await hideElementsExceptCanvas(page);
    await delay(1000);

    const canvas = await page.$("canvas.widget-scene-canvas");
    if (!canvas) {
      throw new Error("Street view canvas not found");
    }

    const screenshotBuffer = await canvas.screenshot();
    return await compressImage(Buffer.from(screenshotBuffer));
  } catch (error) {
    console.error("Error capturing street view:", error);
    return null;
  }
}

// Helper function to process image gallery
async function processImageGallery(page: Page, mapariId: string): Promise<string[]> {
  const imageUrls: string[] = [];
  
  try {
    await page.waitForSelector("a.OKAoZd", { visible: true, timeout: 10000 });
    const imageLinks = await page.$$("a.OKAoZd");
    const totalImages = Math.min(imageLinks.length, MAX_IMAGES);

    for (let i = 0; i < totalImages; i++) {
      const currentLinks = await page.$$("a.OKAoZd");
      const link = currentLinks[i];

      try {
        await processImageLink(page, link);
        const canvas = await page.$("canvas.widget-scene-canvas");
        
        if (canvas && await isCanvasVisible(page)) {
          const screenshotBuffer = await canvas.screenshot();
          const compressedBuffer = await compressImage(Buffer.from(screenshotBuffer));
          
          const fileName = `${mapariId}/image_${i + 1}.jpg`;
          const s3Url = await uploadToS3(compressedBuffer, fileName);
          imageUrls.push(s3Url);
        }
      } catch (error) {
        console.error(`Error processing image ${i + 1}:`, error);
      }
    }
  } catch (error) {
    console.error("Error processing image gallery:", error);
  }

  return imageUrls;
}

async function getPlaceBatch(): Promise<any[]> {
  const now = new Date();
  const timeoutThreshold = new Date(now.getTime() - (PROCESSING_TIMEOUT_MINUTES * 60 * 1000));

  try {
    // Start a transaction
    const { data: lockedPlaces, error: lockError } = await supabase.rpc('lock_places_batch', {
      worker_identifier: WORKER_ID,
      batch_size: BATCH_SIZE,
      timeout_threshold: timeoutThreshold.toISOString()
    });

    if (lockError) {
      console.error('Error locking places:', lockError);
      return [];
    }

    return lockedPlaces || [];

  } catch (error) {
    console.error('Error in getPlaceBatch:', error);
    return [];
  }
}

// Modified function to mark place as completed or release lock if failed
async function updatePlaceStatus(mapariId: string, imageUrls: string[] | null, error: string | null = null) {
  try {
    if (imageUrls && imageUrls.length > 0) {
      // Successfully processed
      const { error: updateError } = await supabase
        .from('google_places')
        .update({
          google_images: imageUrls.join(','),
          processing_status: 'completed',
          processing_worker: null,
          processing_started_at: null,
          last_processed_at: new Date().toISOString(),
          processing_error: null
        })
        .eq('mapari_id', mapariId);

      if (updateError) throw updateError;
    } else {
      // Failed or no images
      const { error: updateError } = await supabase
        .from('google_places')
        .update({
          processing_status: error ? 'failed' : 'pending',
          processing_worker: null,
          processing_started_at: null,
          last_processed_at: new Date().toISOString(),
          processing_error: error
        })
        .eq('mapari_id', mapariId);

      if (updateError) throw updateError;
    }
  } catch (error) {
    console.error(`Error updating status for place ${mapariId}:`, error);
  }
}

// Modified main function
async function main() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    let processedCount = 0;
    
    while (true) {
      // Get batch of places with locking mechanism
      const places = await getPlaceBatch();

      if (!places || places.length === 0) {
        console.log("No places available to process, waiting before next attempt...");
        await delay(10000); // Wait 10 seconds before trying again
        continue;
      }

      console.log(`Processing batch of ${places.length} places...`);

      for (const place of places) {
        try {
          console.log(`Processing place ${place.mapari_id} with worker ${WORKER_ID}...`);
          const imageUrls = await processPlace(page, place.mapari_id, place.place_url);
          await updatePlaceStatus(place.mapari_id, imageUrls);
          processedCount++;
          console.log(`Successfully processed ${processedCount} places`);
        } catch (error: any) {
          console.error(`Error processing place ${place.mapari_id}:`, error);
          await updatePlaceStatus(place.mapari_id, null, error.message);
        }
      }

      // Optional: Add delay between batches
      await delay(5000);
    }
  } catch (error) {
    console.error("An error occurred:", error);
  } finally {
    await browser.close();
  }
}

// Helper function to create a delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to compress image using Sharp
const compressImage = async (inputBuffer: Buffer): Promise<Buffer> => {
  return await sharp(inputBuffer)
    .trim()
    .jpeg({
      quality: 70,
      mozjpeg: true,
    })
    .withMetadata()
    .toBuffer();
};

// Helper function to check if canvas is visible
const isCanvasVisible = async (page: Page): Promise<boolean> => {
  return await page.evaluate(() => {
    const canvas = document.querySelector('canvas.widget-scene-canvas');
    if (!canvas) return false;
    
    const style = window.getComputedStyle(canvas);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
};

// Helper function to hide elements except canvas
const hideElementsExceptCanvas = async (page: Page) => {
  await page.evaluate(() => {
    const elements = document.body.getElementsByTagName("*");
    Array.from(elements).forEach((element) => {
      const isCanvas = element.tagName === "CANVAS";
      const isCanvasParent = element.querySelector("canvas.widget-scene-canvas");
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

// Start the process
main().catch(console.error);