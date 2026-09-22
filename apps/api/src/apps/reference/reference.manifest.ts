import { HexyrnAppManifest } from '@hexyrn/app-sdk';
import { ApplicationRegistryService } from '../../platform/app-registry/application-registry.service';

/**
 * com.hexyrn.reference - a deliberately tiny internal test/reference
 * application. P1 item 17. It exists SOLELY to prove an app can register
 * and use Core correctly through the supported App SDK without bypassing
 * any boundary - it is not a customer product and never will be.
 */
export const REFERENCE_APP_MANIFEST: HexyrnAppManifest = {
  appId: 'com.hexyrn.reference',
  displayName: 'Hexyrn Reference App',
  version: '1.0.0',
  majorVersion: 1,
  requiresCoreVersion: '^0.1.0',
  description: 'Internal reference application exercising every P1 platform mechanism through the App SDK.',

  permissions: [
    { key: 'reference.widget.view', label: 'View widgets' },
    { key: 'reference.widget.create', label: 'Create widgets' },
    { key: 'reference.widget.submit', label: 'Submit widgets for approval' },
    { key: 'reference.widget.approve', label: 'Approve widgets' },
  ],

  navigation: [{ key: 'reference-widgets', label: 'Reference Widgets', path: '/reference/widgets', permission: 'reference.widget.view', order: 999 }],

  capabilities: [{ capability: 'reference.thing.v1', provides: { serviceRef: 'ReferenceThingService' } }],

  eventsPublished: [{ eventType: 'reference.widget.approved', version: 1, description: 'Published when a reference widget completes its approval workflow.' }],

  numberingSequences: [{ sequenceKey: 'widget', prefix: 'WID-', padLength: 6 }],

  defaultForms: [
    {
      formKey: 'widget.create',
      label: 'Create Widget',
      definition: {
        sections: [
          {
            key: 'main',
            label: 'Widget Details',
            fields: [
              { key: 'title', label: 'Title', type: 'text', required: true },
              { key: 'warranty_status', label: 'Warranty Status', type: 'select', options: ['active', 'expired'] },
            ],
          },
        ],
      },
    },
  ],

  defaultWorkflows: [
    {
      workflowKey: 'widget-approval',
      definition: {
        states: ['draft', 'submitted', 'approved', 'rejected'],
        initialState: 'draft',
        transitions: [
          { from: 'draft', to: 'submitted', permission: 'reference.widget.submit' },
          { from: 'submitted', to: 'approved', permission: 'reference.widget.approve' },
          { from: 'submitted', to: 'rejected', permission: 'reference.widget.approve' },
        ],
      },
    },
  ],
};

export async function registerReferenceApp(registry: ApplicationRegistryService): Promise<void> {
  await registry.registerApp(REFERENCE_APP_MANIFEST);
}
