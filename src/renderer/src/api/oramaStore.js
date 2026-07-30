import { create, insert, insertMultiple, search, remove, removeMultiple } from '@orama/orama'
import { generateVector } from './vectorMemory'

// Dimensi vektor sesuai model Transformers.js (all-MiniLM-L6-v2 = 384)
const VECTOR_SIZE = 384

let archiveIndex = null
let documentIndex = null
let memoryIndex = null

export async function initOramaIndices() {
  memoryIndex = await create({
    schema: {
      type: 'string',
      summary: 'string',
      memory: 'string',
      timestamp: 'number',
      dexieId: 'number',
      vector: `vector[${VECTOR_SIZE}]`
    }
  })
  archiveIndex = await create({
    schema: {
      summary: 'string',
      topic: 'string',
      timestamp: 'number',
      dexieId: 'number',       // Referensi ke ID di Dexie
      vector: `vector[${VECTOR_SIZE}]`
    }
  })

  documentIndex = await create({
    schema: {
      docName: 'string',
      chunkIndex: 'number',
      content: 'string',
      timestamp: 'number',
      dexieId: 'number',
      vector: `vector[${VECTOR_SIZE}]`
    }
  })
}

// Dipanggil saat app start: load semua data Dexie ke Orama
export async function hydrateFromDexie() {
  const { db } = await import('./db')

  const archives = await db.chatArchive.toArray()
  const validArchives = []
  const needsMigration = localStorage.getItem('migrated_vectors_v1') !== 'true'

  for (let a of archives) {
    if (needsMigration || !a.vector || a.vector.length !== VECTOR_SIZE) {
      console.log(`[Orama] Re-generating vector for archive ID ${a.id}`)
      a.vector = await generateVector(a.summary)
      if (a.vector && a.vector.length === VECTOR_SIZE) {
        db.chatArchive.update(a.id, { vector: a.vector }).catch(console.error)
      }
    }
    if (a.vector && a.vector.length === VECTOR_SIZE) {
      validArchives.push({
        summary: a.summary,
        topic: a.topic || 'General',
        timestamp: a.timestamp || Date.now(),
        dexieId: a.id,
        vector: a.vector
      })
    }
  }

  if (validArchives.length > 0) {
    await insertMultiple(archiveIndex, validArchives)
  }

  const docs = await db.documents.toArray()
  const validDocs = []
  for (let d of docs) {
    if (needsMigration || !d.vector || d.vector.length !== VECTOR_SIZE) {
      console.log(`[Orama] Re-generating vector for doc ID ${d.id}`)
      d.vector = await generateVector(d.content)
      if (d.vector && d.vector.length === VECTOR_SIZE) {
        db.documents.update(d.id, { vector: d.vector }).catch(console.error)
      }
    }
    if (d.vector && d.vector.length === VECTOR_SIZE) {
      validDocs.push({
        docName: d.docName,
        chunkIndex: d.chunkIndex,
        content: d.content,
        timestamp: d.timestamp || Date.now(),
        dexieId: d.id,
        vector: d.vector
      })
    }
  }

  if (validDocs.length > 0) {
    await insertMultiple(documentIndex, validDocs)
  }

  const memories = await db.memory.toArray()
  const validMemories = []
  for (let m of memories) {
    if (needsMigration || !m.vector || m.vector.length !== VECTOR_SIZE) {
      console.log(`[Orama] Re-generating vector for memory ID ${m.id}`)
      m.vector = await generateVector(m.memory)
      if (m.vector && m.vector.length === VECTOR_SIZE) {
        db.memory.update(m.id, { vector: m.vector }).catch(console.error)
      }
    }
    if (m.vector && m.vector.length === VECTOR_SIZE) {
      validMemories.push({
        type: m.type || 'notes',
        summary: m.summary || '',
        memory: m.memory || '',
        timestamp: Date.now(),
        dexieId: m.id,
        vector: m.vector
      })
    }
  }

  if (validMemories.length > 0) {
    await insertMultiple(memoryIndex, validMemories)
  }

  if (needsMigration) {
    localStorage.setItem('migrated_vectors_v1', 'true')
    console.log('[Orama] Successfully migrated all old vectors to new model!')
  }

  console.log(`[Orama] Hydrated: ${validArchives.length} archives, ${validDocs.length} doc chunks, ${validMemories.length} memories`)
}

// Vector search di arsip obrolan
export async function searchArchives(queryVector, limit = 3) {
  if (!archiveIndex) return []
  try {
    const results = await search(archiveIndex, {
      mode: 'vector',
      vector: { value: queryVector, property: 'vector' },
      similarity: 0.25,
      limit
    })
    console.log(`[Orama] Found ${results.hits.length} archives. Scores:`, results.hits.map(h => h.score))
    return results.hits.map(hit => hit.document)
  } catch (err) {
    console.error('[Orama] Error in searchArchives:', err)
    return []
  }
}

// Vector search di dokumen RAG
export async function searchDocuments(queryText, queryVector, limit = 5) {
  if (!documentIndex) {
    console.log('[Orama] documentIndex is null!')
    return []
  }
  try {
    console.log(`[Orama] Searching documents for: "${queryText}", vector length: ${queryVector?.length}`)
    const results = await search(documentIndex, {
      term: queryText,
      mode: 'hybrid',
      vector: { value: queryVector, property: 'vector' },
      similarity: 0.25,
      limit
    })
    console.log(`[Orama] Found ${results.hits.length} documents. Scores:`, results.hits.map(h => h.score))
    return results.hits.map(hit => hit.document)
  } catch (error) {
    console.error('[Orama] Error in searchDocuments:', error)
    return []
  }
}

// Insert baru (dipanggil setelah Dexie.add)
export async function insertArchiveToOrama(data) {
  if (!archiveIndex) return
  await insert(archiveIndex, data)
}

export async function insertDocumentChunksToOrama(chunks) {
  if (!documentIndex) return
  await insertMultiple(documentIndex, chunks)
}

export async function deleteArchiveFromOrama(dexieId) {
  if (!archiveIndex || !dexieId) return
  try {
    const res = await search(archiveIndex, { where: { dexieId: Number(dexieId) } })
    if (res.hits.length > 0) {
      for (let h of res.hits) {
        await remove(archiveIndex, h.id)
      }
    }
  } catch (err) {
    console.error('[Orama] Error deleteArchiveFromOrama:', err)
  }
}

export async function deleteDocumentFromOrama(docName) {
  if (!documentIndex) return
  const res = await search(documentIndex, { term: docName, properties: ['docName'] })
  const ids = res.hits.map(h => h.id)
  await removeMultiple(documentIndex, ids)
}

// ======================== MEMORY ORAMA INDEX ========================

export async function searchMemoriesInOrama(queryText, queryVector, limit = 5, filterTypes = null) {
  if (!memoryIndex || !queryVector) return []
  try {
    const results = await search(memoryIndex, {
      term: queryText,
      mode: 'hybrid',
      vector: { value: queryVector, property: 'vector' },
      similarity: 0.25,
      limit: limit * 4
    })
    let hits = results.hits.map(hit => ({ ...hit.document, id: hit.document.dexieId, score: hit.score }))
    if (filterTypes) {
      const typesArr = Array.isArray(filterTypes) ? filterTypes : [filterTypes]
      hits = hits.filter(h => typesArr.includes(h.type))
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  } catch (err) {
    console.error('[Orama] Error in searchMemoriesInOrama:', err)
    return []
  }
}

export async function insertMemoryToOrama(data) {
  if (!memoryIndex || !data.vector || data.vector.length !== VECTOR_SIZE) return
  try {
    await insert(memoryIndex, {
      type: data.type || 'notes',
      summary: data.summary || '',
      memory: data.memory || '',
      timestamp: Date.now(),
      dexieId: data.id,
      vector: data.vector
    })
  } catch (err) {
    console.error('[Orama] Error insertMemoryToOrama:', err)
  }
}

export async function updateMemoryInOrama(dexieId, data) {
  if (!memoryIndex) return
  await deleteMemoryFromOrama(dexieId)
  await insertMemoryToOrama({ ...data, id: dexieId })
}

export async function deleteMemoryFromOrama(dexieId) {
  if (!memoryIndex || !dexieId) return
  try {
    const res = await search(memoryIndex, { where: { dexieId: Number(dexieId) } })
    if (res.hits.length > 0) {
      for (let h of res.hits) {
        await remove(memoryIndex, h.id)
      }
    }
  } catch (err) {
    console.error('[Orama] Error deleteMemoryFromOrama:', err)
  }
}

export async function findSimilarMemoryClusters(threshold = 0.60) {
  if (!memoryIndex) {
    console.warn('[Orama Groomer] memoryIndex belum siap!')
    return []
  }
  try {
    console.log('[Orama Groomer] Memulai scanning cluster memori di Orama dengan threshold:', threshold)
    const results = await search(memoryIndex, {
      term: '',
      limit: 1000
    })
    let memories = results.hits
      .map(hit => ({
        ...hit.document,
        id: hit.document.dexieId
      }))
      .filter(m => m.type === 'profile' || m.type === 'preference')

    const visited = new Set()
    const clusters = []
    let groupCount = 1

    for (const mem of memories) {
      if (visited.has(mem.id)) continue
      if (!mem.vector || !Array.isArray(mem.vector)) {
        visited.add(mem.id)
        continue
      }

      const simResults = await search(memoryIndex, {
        term: mem.memory,
        mode: 'hybrid',
        vector: { value: mem.vector, property: 'vector' },
        similarity: threshold,
        limit: 20
      })

      if (simResults.hits.length > 1) {
        console.log(
          '[Orama Groomer] Kandidat mirip untuk:',
          mem.memory,
          '-> scores:',
          simResults.hits.map(h => `${h.score.toFixed(2)} (${h.document.memory.slice(0, 30)}...)`)
        )
      }

      const similarHits = simResults.hits
        .map(hit => ({
          ...hit.document,
          id: hit.document.dexieId,
          score: hit.score
        }))
        .filter(
          h =>
            (h.type === 'profile' || h.type === 'preference') &&
            h.score >= threshold &&
            !visited.has(h.id)
        )

      if (similarHits.length >= 2) {
        similarHits.forEach(h => visited.add(h.id))
        clusters.push({
          group: groupCount++,
          items: similarHits.map(h => ({
            id: h.id,
            type: h.type,
            memory: h.memory,
            timestamp: h.timestamp
          }))
        })
      } else {
        visited.add(mem.id)
      }
    }

    console.log(`[Orama Groomer] Ditemukan ${clusters.length} cluster dari total ${memories.length} memori profile/preference.`)
    return clusters
  } catch (err) {
    console.error('[Orama] Error in findSimilarMemoryClusters:', err)
    return []
  }
}

// On-the-fly Orama Hybrid Vector Search for read-document
export async function searchDocumentWithOrama(rawText, searchQuery, limit = 5) {
  try {
    if (!rawText || !searchQuery) return []

    // 1. Chunk text (500 chars with 50 overlap)
    const chunks = []
    let start = 0
    const chunkSize = 500
    const overlap = 50
    while (start < rawText.length) {
      const end = Math.min(start + chunkSize, rawText.length)
      const chunkStr = rawText.slice(start, end).trim()
      if (chunkStr) chunks.push(chunkStr)
      start += chunkSize - overlap
    }

    if (chunks.length === 0) return []

    // 2. Create in-memory Orama instance
    const tempDb = await create({
      schema: {
        content: 'string',
        vector: `vector[${VECTOR_SIZE}]`
      }
    })

    // 3. Generate vectors and insert
    for (let i = 0; i < chunks.length; i++) {
      const vec = await generateVector(chunks[i])
      if (vec && vec.length === VECTOR_SIZE) {
        await insert(tempDb, {
          content: chunks[i],
          vector: vec
        })
      }
    }

    // 4. Generate query vector and search
    const queryVec = await generateVector(searchQuery)
    if (!queryVec || queryVec.length !== VECTOR_SIZE) return []

    const searchRes = await search(tempDb, {
      term: searchQuery,
      mode: 'hybrid',
      vector: { value: queryVec, property: 'vector' },
      similarity: 0.15,
      limit: limit
    })

    return searchRes.hits.map((h) => ({
      content: h.document.content,
      score: h.score
    }))
  } catch (err) {
    console.error('[Orama] Error in searchDocumentWithOrama:', err)
    return []
  }
}
