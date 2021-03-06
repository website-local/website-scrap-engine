# website-scrap-engine
Configurable website scraper in typescript.

## Features
- [x] Resource types
- [x] Configurable process pipeline
- [x] Options
- [x] Logger
- [x] Concurrent downloader
- [x] Multi-thread processing (with native worker_thread)
- [x] Process CSS
- [x] Process HTML
- [x] Process SiteMap (but not replace path in it)
- [x] Configurable logging

## Multi-thread processing
Note: use multi-thread processing
only if your process is cpu sensitive.

* Main thread
    * resource downloading in queue
    * process after download
    * save binary resources to disk
    * send other resources to worker thread
    * enqueue non-duplicated resource from worker thread
* Worker thread
    * receive downloaded resource from main thread
    * process after download
        * parse html, css, etc.
    * collect referenced resources
    * process and filter referenced resources before download
    * send referenced resources to main thread
    * save resources to disk

## Pipeline life cycle
* skip or redirect link
* detect resource type
* create
* process before download
* download
* process after download
* save to disk
