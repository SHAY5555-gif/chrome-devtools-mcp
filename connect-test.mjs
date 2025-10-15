import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: null,
  targetFilter: target => {
    if (target.url() === "chrome://newtab/") {
      return true;
    }
    for (const prefix of ["chrome://", "chrome-extension://", "chrome-untrusted://", "devtools://"]) {
      if (target.url().startsWith(prefix)) {
        return false;
      }
    }
    return true;
  },
});
const pages = await browser.pages();
console.log("pages", pages.length);
for (const [i, page] of pages.entries()) {
  console.log(i, page.url());
}
await browser.disconnect();
