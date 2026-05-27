/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="../goja_plugin_types/core.d.ts" />

const BASE_URL = "https://feed.animetosho.org/json"
const ARM_URL = "https://arm.haglund.dev/api/v2/ids"
const ZENSHIN_URL = "https://zenshin-supabase-api.onrender.com/mappings"

type ToshoEntry = {
    title?: string
    torrent_name?: string
    magnet_uri?: string
    torrent_url?: string
    info_hash?: string
    total_size?: number
    seeders?: number
    leechers?: number
    torrent_downloaded_count?: number
    timestamp?: number
    num_files?: number
    anidb_fid?: number
}

// Resposta da zenshin API por episódio
type ZenshinEpisode = {
    episode: string
    anidbEid: string
    type: string
    episodeNumber?: number
    absoluteEpisodeNumber?: number
}

type ZenshinResponse = {
    episodes: Record<string, ZenshinEpisode>
    mappings?: {
        anilist_id?: number
        anidb_id?: number
    }
}

//@ts-ignore
class Provider {
    canSmartSearch = true
    supportsAdult = false

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const res = await fetch(BASE_URL)
            const data = await res.json()
            return data.length ? this.mapEntries(data, false) : []
        } catch (error) {
            console.error("animetosho: Error fetching latest: " + (error as Error).message)
            return []
        }
    }

    async search(options: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const url = `${BASE_URL}?q=${encodeURIComponent(options.query)}&qx=1`
            console.log("animetosho: Searching: " + url)
            const res = await fetch(url)
            const data = await res.json()
            return data.length ? this.mapEntries(data, false) : []
        } catch (error) {
            console.error("animetosho: Error searching: " + (error as Error).message)
            return []
        }
    }

    async smartSearch(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const { media, batch, episodeNumber, resolution } = options
            const isMovie = media.format === "MOVIE" && (media.episodeCount || 0) === 1
            const anilistId = media.id
            const qualityFilter = this.buildQualityFilter(resolution)

            // Busca AniDB ID e mapeamento de episódios em paralelo
            const [anidbId, zenshin] = await Promise.all([
                this.resolveAnidbId(anilistId),
                (!batch && !isMovie) ? this.fetchZenshinMappings(anilistId) : Promise.resolve(null),
            ])

            if (!anidbId) {
                console.warn("animetosho: Could not resolve AniDB ID for AniList " + anilistId + ", falling back to text search")
                return await this.fallbackTextSearch(options)
            }

            console.log("animetosho: AniList " + anilistId + " -> AniDB " + anidbId)

            if (batch && !isMovie) {
                return await this.fetchBatch(anidbId, episodeNumber, qualityFilter)
            }

            if (isMovie) {
                return await this.fetchMovie(anidbId, qualityFilter)
            }

            // Episódio único — tenta via eid primeiro
            const anidbEid = zenshin ? this.resolveEpisodeId(zenshin, episodeNumber) : null

            if (anidbEid) {
                console.log("animetosho: Episode " + episodeNumber + " -> AniDB eid " + anidbEid)
                return await this.fetchByEid(anidbEid, qualityFilter)
            }

            // Fallback: busca por aid + filtra por número de episódio
            console.log("animetosho: No eid found for ep " + episodeNumber + ", fetching by aid")
            return await this.fetchEpisodeByAid(anidbId, episodeNumber, qualityFilter, media)

        } catch (error) {
            console.error("animetosho: Smart search error: " + (error as Error).message)
            return []
        }
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: this.canSmartSearch,
            smartSearchFilters: ["batch", "episodeNumber", "resolution"],
            supportsAdult: false,
            type: "main",
        }
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // RESOLUÇÃO DE IDs
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // AniList ID → AniDB ID via arm-server
    private async resolveAnidbId(anilistId: number): Promise<number | null> {
        try {
            const res = await fetch(ARM_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ anilist: anilistId }),
            })
            if (!res.ok) return null
            const data = await res.json()
            const id = data?.anidb
            return (id && typeof id === "number") ? id : null
        } catch (error) {
            console.error("animetosho: arm-server error: " + (error as Error).message)
            return null
        }
    }

    // Busca mapeamento completo de episódios via zenshin API
    // Retorna o objeto com episodes[episodeNumber].anidbEid
    private async fetchZenshinMappings(anilistId: number): Promise<ZenshinResponse | null> {
        try {
            const url = `${ZENSHIN_URL}?anilist_id=${anilistId}`
            console.log("animetosho: Fetching episode mappings from zenshin: " + url)
            const res = await fetch(url)
            if (!res.ok) return null
            const data = await res.json()
            if (!data?.episodes) return null
            return data as ZenshinResponse
        } catch (error) {
            console.error("animetosho: zenshin error: " + (error as Error).message)
            return null
        }
    }

    // Extrai o anidbEid do episódio pelo número relativo (1-based)
    private resolveEpisodeId(zenshin: ZenshinResponse, episodeNumber: number): string | null {
        const episodes = zenshin.episodes
        if (!episodes) return null

        // Tenta pelo número do episódio como string direto (chave "1", "2", ...)
        const directKey = String(episodeNumber)
        if (episodes[directKey]?.anidbEid) {
            return episodes[directKey].anidbEid
        }

        // Busca por episodeNumber ou absoluteEpisodeNumber no valor
        for (const key of Object.keys(episodes)) {
            const ep = episodes[key]
            // Só episódios regulares
            if (ep.type && ep.type !== "Regular Episode") continue
            if (
                ep.episodeNumber === episodeNumber ||
                ep.absoluteEpisodeNumber === episodeNumber
            ) {
                return ep.anidbEid || null
            }
        }

        return null
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // FETCH POR EID / AID
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Busca pelo AniDB Episode ID — mais preciso, retorna só torrents daquele episódio
    private async fetchByEid(anidbEid: string, qualityFilter: string): Promise<AnimeTorrent[]> {
        const url = `${BASE_URL}?eid=${anidbEid}${qualityFilter}`
        console.log("animetosho: Fetching by eid: " + url)
        const res = await fetch(url)
        const data = await res.json() as ToshoEntry[]
        return data.length ? this.mapEntries(data, false) : []
    }

    // Fallback: busca por aid e filtra localmente pelo número de episódio
    private async fetchEpisodeByAid(
        anidbId: number,
        episodeNumber: number,
        qualityFilter: string,
        media: Media
    ): Promise<AnimeTorrent[]> {
        const url = `${BASE_URL}?aid=${anidbId}${qualityFilter}`
        console.log("animetosho: Fetching ep " + episodeNumber + " by aid: " + url)
        const res = await fetch(url)
        const data = await res.json() as ToshoEntry[]
        if (!data.length) return []

        const all = this.mapEntries(data, false)

        const filtered = all.filter(t => {
            const ep = t.episodeNumber ?? -1
            if (ep === episodeNumber) return true
            const absOffset = (media.absoluteSeasonOffset || 0)
            if (absOffset > 0 && ep === episodeNumber + absOffset) return true
            return false
        })

        return filtered.length > 0 ? filtered : all
    }

    // Busca batch via aid ordenado por tamanho, filtra por num_files
    private async fetchBatch(
        anidbId: number,
        episodeNumber: number,
        qualityFilter: string
    ): Promise<AnimeTorrent[]> {
        const url = `${BASE_URL}?order=size-d&aid=${anidbId}${qualityFilter}`
        console.log("animetosho: Fetching batch by aid: " + url)
        const res = await fetch(url)
        const data = await res.json() as ToshoEntry[]
        if (!data.length) return []

        const minFiles = Math.min(24, Math.max(2, episodeNumber ?? 1))
        const filtered = data.filter(e => (e.num_files || 0) >= minFiles)
        return this.mapEntries(filtered.length ? filtered : data, true)
    }

    // Busca filme via aid sem filtro de num_files
    private async fetchMovie(anidbId: number, qualityFilter: string): Promise<AnimeTorrent[]> {
        const url = `${BASE_URL}?aid=${anidbId}${qualityFilter}`
        console.log("animetosho: Fetching movie by aid: " + url)
        const res = await fetch(url)
        const data = await res.json() as ToshoEntry[]
        return data.length ? this.mapEntries(data, false) : []
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // FALLBACK TEXTUAL
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private async fallbackTextSearch(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const { media, batch, episodeNumber, resolution } = options
        const title = media.romajiTitle || media.englishTitle || ""
        if (!title) return []

        const qualityFilter = this.buildQualityFilter(resolution)
        let query: string

        if (batch) {
            query = `${title} (Batch|Complete)`
        } else {
            const ep = this.zeropad(episodeNumber)
            query = `${title} ${ep}`
        }

        const url = `${BASE_URL}?q=${encodeURIComponent(query)}&qx=1${qualityFilter}`
        console.log("animetosho: Fallback text search: " + url)

        try {
            const res = await fetch(url)
            const data = await res.json() as ToshoEntry[]
            return data.length ? this.mapEntries(data, batch) : []
        } catch (error) {
            console.error("animetosho: Fallback error: " + (error as Error).message)
            return []
        }
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // HELPERS
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Monta filtro de qualidade no formato nativo do Tosho
    // qx=1 habilita o modo de busca avançada (expressões booleanas)
    // Ex com resolução: &qx=1&q=("1080"+!"720"+!"540"+!"480")
    // Ex sem resolução: &qx=1
    private buildQualityFilter(resolution: string): string {
        const qualities = ["1080", "720", "540", "480"]
        if (!resolution) return "&qx=1"
        const excluded = qualities.filter(q => q !== resolution)
        const excl = excluded.map(q => `!"${q}"`).join("+")
        return `&qx=1&q=("${resolution}"+${excl})`
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // MAPEAMENTO DE ENTRIES DO TOSHO
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private mapEntries(entries: ToshoEntry[], isBatch: boolean): AnimeTorrent[] {
        return entries.map(e => this.mapSingleEntry(e, isBatch))
    }

    private mapSingleEntry(entry: ToshoEntry, isBatch: boolean): AnimeTorrent {
        const seeders = (entry.seeders || 0) >= 3e4 ? 0 : (entry.seeders || 0)
        const leechers = (entry.leechers || 0) >= 3e4 ? 0 : (entry.leechers || 0)

        let formattedDate = ""
        try {
            const d = new Date(1000 * (entry.timestamp || 0))
            if (!isNaN(d.getTime())) formattedDate = d.toISOString()
        } catch (e) { }

        const name: string = entry.title || entry.torrent_name || ""

        // Detecta range de episódios → batch
        let episodeNumber = -1
        let isBatchByRange = false

        const rangeMatch = name.match(/(?:^|[\s\[\(])0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})(?:[\s\]\)]|$)/)
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1])
            const end = parseInt(rangeMatch[2])
            if (end > start && start >= 1 && end <= 300) {
                isBatchByRange = true
            }
        }

        if (!isBatchByRange) {
            // E05, EP05, S01E05
            const epMatch = name.match(/(?:[Ee][Pp]?|S\d{1,2}E)0*(\d{1,3})/)
            if (epMatch) {
                episodeNumber = parseInt(epMatch[1]) || -1
            } else {
                // número isolado: "Anime Name - 05 [1080p]"
                const isolated = name.match(/[-\s]0*(\d{1,3})(?:\s*[\[\(v]|$)/)
                if (isolated) {
                    const n = parseInt(isolated[1])
                    if (n >= 1 && n <= 300) episodeNumber = n
                }
            }
        }

        const finalIsBatch = isBatch || isBatchByRange
        if (finalIsBatch) episodeNumber = -1

        // resolução
        let resolution = ""
        const resMatch = name.match(/\b(2160|1080|720|540|480)p?\b/)
        if (resMatch) resolution = resMatch[1]

        return {
            name,
            date: formattedDate,
            size: entry.total_size || 0,
            formattedSize: this.formatSize(entry.total_size || 0),
            seeders,
            leechers,
            downloadCount: entry.torrent_downloaded_count || 0,
            link: entry.magnet_uri || entry.torrent_url || "",
            downloadUrl: entry.torrent_url || "",
            infoHash: entry.info_hash || "",
            magnetLink: entry.magnet_uri || "",
            resolution,
            isBatch: finalIsBatch,
            episodeNumber,
            releaseGroup: "",
            // anidb_fid = entrada verificada/linkada com episódio do AniDB
            isBestRelease: !!(entry.anidb_fid && !finalIsBatch),
            confirmed: false,
        } as AnimeTorrent
    }

    private zeropad(v: number): string {
        const s = String(v)
        return s.length < 2 ? "0" + s : s
    }

    private formatSize(bytes: number): string {
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GiB"
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + " MiB"
        return (bytes / 1024).toFixed(2) + " KiB"
    }
}