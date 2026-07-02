import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'lawyer', 
        location = 'London', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'GB'
    });

    log.info(`Searching Law Society UK for "${keyword}" in "${location}"`);
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            await page.waitForSelector('#solicitor-search-results, .search-results, article, .listing', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM'));

            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Attention') || await page.$('text="Please turn JavaScript on"')) {
                throw new Error('Blocked by WAF. Retrying with residential proxy...');
            }

            // Law Society uses specific classes for results
            const results = await page.$$('#solicitor-search-results > article, .search-result');
            
            for (const item of results) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('h2, .name');
                if (!nameElement) continue;
                const firmName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('address, .address');
                const address = addressElement ? (await addressElement.innerText()).trim().replace(/\s+/g, ' ') : '';

                // Phones
                const phoneElement = await item.$('a[href^="tel:"], .telephone');
                const phone = phoneElement ? (await phoneElement.innerText()).trim() : '';
                
                // Website
                const websiteElement = await item.$('a[href^="http"]:not([href*="lawsociety.org.uk"]), a.website');
                const website = websiteElement ? await websiteElement.getAttribute('href') : '';
                
                // Specialty/Type
                const typeElement = await item.$('.type, .solicitor-type');
                const specialty = typeElement ? (await typeElement.innerText()).trim() : keyword;

                const urlElement = await item.$('h2 a, a.more-details');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://solicitors.lawsociety.org.uk').toString() : listingUrl;

                if (firmName && firmName.length > 2) {
                    const record = {
                        firmName,
                        specialty,
                        address,
                        phone,
                        website,
                        listingUrl: fullListingUrl,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${firmName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('a.next, a:has-text("Next")');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://solicitors.lawsociety.org.uk').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    const startUrl = `https://solicitors.lawsociety.org.uk/search/results?Pro=True&Type=0&Name=${encodeURIComponent(keyword)}&Location=${encodeURIComponent(location)}`;
    
    await crawler.addRequests([{
        url: startUrl
    }]);

    await crawler.run();

    log.info(`🎉 Done! Extracted ${extractedCount} UK legal leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
