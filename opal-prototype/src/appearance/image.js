export async function waitForImage(url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  let timeout;
  try {
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error("The background image took too long to load.")), 8000);
      }),
    ]);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("The background image could not be loaded.");
    return image;
  } catch (error) {
    image.removeAttribute("src");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
