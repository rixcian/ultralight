import { SignableENR } from '@chainsafe/enr'
import { Block, BlockHeader } from '@ethereumjs/block'
import { createSecp256k1PeerId } from '@libp2p/peer-id-factory'
import { multiaddr } from '@multiformats/multiaddr'
import { assert, it } from 'vitest'

import { UltralightProvider } from '../../src/client/provider.js'
import { TransportLayer } from '../../src/index.js'
import { NetworkId } from '../../src/networks/types.js'
import { MockProvider } from '../testUtils/mockProvider.js'

it('Test provider functionality', async () => {
  const ma = multiaddr('/ip4/0.0.0.0/udp/1500')
  const peerId = await createSecp256k1PeerId()
  const enr = SignableENR.createFromPeerId(peerId)
  enr.setLocationMultiaddr(ma)
  const provider = await UltralightProvider.create(new MockProvider(), {
    bindAddress: '0.0.0.0',
    transport: TransportLayer.NODE,
    config: {
      bindAddrs: {
        ip4: ma,
      },
      enr,
      peerId,
    },
    supportedNetworks: [{ networkId: NetworkId.HistoryNetwork, radius: 1n }],
  })

  const block = await provider.getBlock(5000)
  assert.ok(block!.number === 5000, 'retrieved block from fallback provider')

  // Stub getBlockByHash for unit testing
  provider.historyNetwork.ETH.getBlockByHash = async (_hash: string) => {
    return Block.fromBlockData({ header: BlockHeader.fromHeaderData({ number: 2n }) })
  }
  const block2 = await provider.getBlock(
    '0xb495a1d7e6663152ae92708da4843337b958146015a2802f4193a410044698c9',
  )
  assert.equal(block2!.number, 2, 'got block 2 from portal network')
  await (provider as any).portal.stop()

  assert.equal(
    1n,
    (await provider._detectNetwork()).chainId,
    'parent class methods work as expected',
  )
})
