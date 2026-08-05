"use client";

import { Button } from "@midday/ui/button";
import { useCustomerParams } from "@/hooks/use-customer-params";

export function EmptyState() {
  const { setParams } = useCustomerParams();

  return (
    <div className="flex items-center justify-center ">
      <div className="flex flex-col items-center mt-40">
        <div className="text-center mb-6 space-y-2">
          <h2 className="font-medium text-lg">No contacts</h2>
          <p className="text-[#606060] text-sm">
            You haven't added any contacts yet. <br />
            Add one, or import from LinkedIn.
          </p>
        </div>

        <Button
          variant="outline"
          onClick={() =>
            setParams({
              createCustomer: true,
            })
          }
        >
          Add contact
        </Button>
      </div>
    </div>
  );
}

export function NoResults() {
  const { setParams } = useCustomerParams();

  return (
    <div className="flex items-center justify-center ">
      <div className="flex flex-col items-center mt-40">
        <div className="text-center mb-6 space-y-2">
          <h2 className="font-medium text-lg">No results</h2>
          <p className="text-[#606060] text-sm">
            Try another search, or adjusting the filters
          </p>
        </div>

        <Button variant="outline" onClick={() => setParams(null)}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}
